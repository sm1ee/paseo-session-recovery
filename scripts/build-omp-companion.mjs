import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import ts from "typescript";

// 배포 앱의 원본 지문이 일치할 때만 데몬 동반 모듈을 생성한다.
// 실행 중 데몬이나 provider를 재시작하지 않는다.
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error("절대 경로의 출력 디렉터리를 지정하세요.");
const serverRoot = process.argv[3] ?? "/Applications/Paseo.app/Contents/Resources/app.asar/node_modules/@getpaseo/server/dist/server/server";
const pins = {
  "session.js": "2a22a6716bec6dd2c52ccdc96449a1fe9f33937a8bf4dff1097bfb52f736b752",
  "agent/providers/omp/agent.js": "5b719cace356b5d6cf16e1dc366419fc2d425409a7b2403ede113a4bd58896d0",
  "agent/providers/omp/cli-runtime.js": "4e66ac097cdeb3e27e4923d2dd2d6237a73d36ffa296aad89d5bafbd2463a971",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");
for (const [name, expected] of Object.entries(pins)) if (hash(await fs.readFile(path.join(serverRoot, name))) !== expected) throw new Error("지원하지 않는 Paseo 원본입니다. 동반 모듈을 적용하지 않았습니다.");
const source = await fs.readFile(new URL("../server/omp-native-goals.ts", import.meta.url), "utf8");
const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, reportDiagnostics: true });
if (result.diagnostics?.length) throw new Error("OMP 동반 모듈 컴파일에 실패했습니다.");
await fs.mkdir(output, { recursive: true, mode: 0o700 });
const helperPath = path.join(output, "omp-native-goals.mjs"), helperHash = hash(result.outputText);
await fs.writeFile(helperPath, result.outputText, { mode: 0o600, flag: "wx" });
const bootstrap = String.raw`'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto'),{registerHooks}=require('node:module'),{pathToFileURL}=require('node:url');
const base=${JSON.stringify(serverRoot)},helper=path.join(__dirname,'omp-native-goals.mjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
let hook;
module.exports.install=function(){
 if(hook)return true;
 if(hash(fs.readFileSync(helper))!==${JSON.stringify(helperHash)})throw Error('OMP 동반 모듈 지문이 변경됐습니다.');
 for(const [file,expected] of Object.entries(${JSON.stringify(pins)}))if(hash(fs.readFileSync(path.join(base,file)))!==expected)throw Error('지원하지 않는 Paseo 원본입니다.');
 const helperURL=pathToFileURL(helper).href;
 const sessionURL=pathToFileURL(path.join(base,'session.js')).href,providerURL=pathToFileURL(path.join(base,'agent/providers/omp/agent.js')).href;
 hook=registerHooks({load(url,context,nextLoad){
  const loaded=nextLoad(url,context);
  if(url!==sessionURL&&url!==providerURL)return loaded;
  const source=typeof loaded.source==='string'?loaded.source:Buffer.from(loaded.source).toString('utf8');
  if(url===providerURL)return {...loaded,source:'import {installOmpSessionTracking as localTrackOmpGoals} from '+JSON.stringify(helperURL)+';\n'+source+'\nlocalTrackOmpGoals(OmpAgentClient);\n'};
  return {...loaded,source:'import {installOmpNativeBridge as localInstallOmpGoals} from '+JSON.stringify(helperURL)+';\n'+source+'\nlocalInstallOmpGoals(Session,(id,session)=>ensureAgentLoaded(id,{agentManager:session.agentManager,agentStorage:session.agentStorage,logger:session.sessionLogger}));\n'};
 }});
 return true;
};
`;
await fs.writeFile(path.join(output, "preload.cjs"), bootstrap, { mode: 0o600, flag: "wx" });
await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify({ version: 1, paseo: "0.12.0", serverRoot, pins, helperHash, bootstrapHash: hash(bootstrap) }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ generated: true, output, helperHash, serverVersion: "0.12.0" }));
