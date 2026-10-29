import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import ts from "typescript";

// 검증한 원본에만 읽기 전용 Goal 연결을 추가한다. 데몬을 재시작하지 않는다.
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error("절대 경로의 출력 디렉터리를 지정하세요.");
const serverRoot = process.argv[3] ?? "/Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server";
const runtimeRoot = process.argv[4] ?? serverRoot;
const pins = {
  "session.js": "e39012ced19b49e1910170adf42410ba13904f3b1c62f23e8c922998774b6a9b",
  "agent/providers/acp-agent.js": "c5bb31249a9b0d3e936e1b73680991ec3ba8b2af13fb98524ae59a29a84fd2e4",
};
const hash = v => createHash("sha256").update(v).digest("hex");
for (const [file, expected] of Object.entries(pins)) if (hash(await fs.readFile(path.join(serverRoot, file))) !== expected) throw new Error("지원하지 않는 Paseo 원본입니다. 동반 모듈을 생성하지 않았습니다.");
const source = await fs.readFile(new URL("../server/devin-native-bridge.ts", import.meta.url), "utf8");
const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
if (result.diagnostics?.length) throw new Error("Devin 동반 모듈 컴파일에 실패했습니다.");
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const helperHash = hash(result.outputText);
await fs.writeFile(path.join(output, "devin-native-goals.mjs"), result.outputText, { flag: "wx", mode: 0o600 });
const bootstrap = String.raw`'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{registerHooks}=require('node:module'),{pathToFileURL}=require('node:url');
const base=${JSON.stringify(runtimeRoot)},helper=path.join(__dirname,'devin-native-goals.mjs');
const hash=v=>createHash('sha256').update(v).digest('hex');
let hook;
module.exports.install=function(){
 if(hook)return true;
 if(hash(fs.readFileSync(helper))!==${JSON.stringify(helperHash)})throw Error('Devin 동반 모듈 지문이 변경됐습니다.');
 for(const [file,expected] of Object.entries(${JSON.stringify(pins)}))if(hash(fs.readFileSync(path.join(base,file)))!==expected)throw Error('지원하지 않는 Paseo 원본입니다.');
 const url=pathToFileURL(helper).href,session=pathToFileURL(path.join(base,'session.js')).href,acp=pathToFileURL(path.join(base,'agent/providers/acp-agent.js')).href;
 hook=registerHooks({load(target,context,nextLoad){
  const loaded=nextLoad(target,context);if(target!==session&&target!==acp)return loaded;
  const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8');
  if(target===acp)return {...loaded,source:'import {installDevinSessionTracking as localTrackDevinGoals} from '+JSON.stringify(url)+';\n'+source+'\nlocalTrackDevinGoals(ACPAgentClient);\n'};
  return {...loaded,source:'import {installDevinNativeBridge as localInstallDevinGoals} from '+JSON.stringify(url)+';\n'+source+'\nlocalInstallDevinGoals(Session);\n'};
 }});return true;
};
`;
await fs.writeFile(path.join(output, "preload.cjs"), bootstrap, { flag: "wx", mode: 0o600 });
await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify({ version: 1, paseo: "0.13.0", serverRoot: runtimeRoot, pins, helperHash, bootstrapHash: hash(bootstrap) }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ generated: true, output, helperHash, sourceRoot: pathToFileURL(serverRoot).href }));
