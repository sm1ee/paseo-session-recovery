import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

// 실행 중 데몬을 재시작하지 않고, 검토한 원본에 맞는 동반 모듈만 생성한다.
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error("절대 경로의 출력 디렉터리를 지정하세요.");
const serverRoot = process.argv[3] ?? "/Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server";
const workspaceStatesPath = process.argv[4] ?? null;
if (workspaceStatesPath && !path.isAbsolute(workspaceStatesPath)) throw new Error("작업공간 어댑터는 절대 경로여야 합니다.");
const pins = {
  "session.js": "2a22a6716bec6dd2c52ccdc96449a1fe9f33937a8bf4dff1097bfb52f736b752",
  "agent/agent-loading.js": "68a49992ea1f6e4813b8a1860cb725bc43cb5d4a4dae6c4db9b5ba0a0e39ae44",
  "agent/agent-manager.js": "c5030ef7eb9577f2822dec0e9bd1b2adcd09fe37137a0516f32a1eba061bce03",
};
const hash = value => createHash("sha256").update(value).digest("hex");
for (const [name, expected] of Object.entries(pins)) if (hash(await fs.readFile(path.join(serverRoot, name))) !== expected) throw new Error("지원하지 않는 Paseo 원본입니다.");
const workspaceHash = workspaceStatesPath ? hash(await fs.readFile(workspaceStatesPath)) : null;
const source = await fs.readFile(new URL("../server/session-connection.ts", import.meta.url), "utf8");
const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
if (result.diagnostics?.length) throw new Error("세션 연결 동반 모듈 컴파일에 실패했습니다.");
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const helperHash = hash(result.outputText);
await fs.writeFile(path.join(output, "session-connection.mjs"), result.outputText, { mode: 0o600, flag: "wx" });
const bootstrap = String.raw`'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{registerHooks}=require('node:module'),{pathToFileURL}=require('node:url');
const base=${JSON.stringify(serverRoot)},helper=path.join(__dirname,'session-connection.mjs'),workspace=${JSON.stringify(workspaceStatesPath)};
const hash=value=>createHash('sha256').update(value).digest('hex');
let hook;
module.exports.install=function(){
 if(hook)return true;
 if(hash(fs.readFileSync(helper))!==${JSON.stringify(helperHash)})throw Error('세션 연결 동반 모듈 지문이 변경됐습니다.');
 for(const [file,expected] of Object.entries(${JSON.stringify(pins)}))if(hash(fs.readFileSync(path.join(base,file)))!==expected)throw Error('지원하지 않는 Paseo 원본입니다.');
 if(workspace&&hash(fs.readFileSync(workspace))!==${JSON.stringify(workspaceHash)})throw Error('작업공간 어댑터가 변경됐습니다.');
 const helperURL=pathToFileURL(helper).href,sessionURL=pathToFileURL(path.join(base,'session.js')).href;
 hook=registerHooks({load(url,context,nextLoad){
  const loaded=nextLoad(url,context);if(url!==sessionURL)return loaded;
  const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8');
  const workspaceImport=workspace?'import {listWorkspaceAgentStates as localConnectionWorkspaceStates} from '+JSON.stringify(pathToFileURL(workspace).href)+';\n':'';
  return {...loaded,source:workspaceImport+'import {installSessionConnectionBridge as localInstallSessionConnection} from '+JSON.stringify(helperURL)+';\n'+source+'\nlocalInstallSessionConnection(Session,(id,session)=>ensureUnarchivedAgentLoaded(id,{agentManager:session.agentManager,agentStorage:session.agentStorage,logger:session.sessionLogger}),'+(workspace?'localConnectionWorkspaceStates':'undefined')+');\n'};
 }});return true;
};
`;
await fs.writeFile(path.join(output, "preload.cjs"), bootstrap, { mode: 0o600, flag: "wx" });
await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify({ version: 1, paseo: "0.12.0", pins, helperHash, bootstrapHash: hash(bootstrap), workspaceStatesPath, workspaceHash }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ generated: true, helperHash, serverVersion: "0.12.0", workspaceAdapter: Boolean(workspaceStatesPath) }));
