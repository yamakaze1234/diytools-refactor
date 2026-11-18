// 仅准备新版的签名更新附件，不推送源码、不发布或修改线上通道，不收集用户 data。
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPrivateKey} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {makeEnvelope,publicKeyBase64,updateProfiles} from './package-portable-update.mjs';
import {verifyGiteaPackage} from './verify-gitea-package.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args={};
for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i];if(!['--exe','--key','--out','--notes','--provenance'].includes(key)||!process.argv[i+1])throw Error('参数无效');args[key.slice(2)]=process.argv[i+1];}
for(const key of ['exe','key','out','notes','provenance'])if(!args[key])throw Error('缺少 '+key);
const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
if(git('status','--porcelain'))throw Error('请先提交候选范围');
const version=JSON.parse(readFileSync(resolve(root,'apps/desktop/src-tauri/tauri.conf.json'))).version;
const binary=readFileSync(args.exe),notes=readFileSync(args.notes,'utf8'),privateKey=createPrivateKey(readFileSync(args.key));
const raw=readFileSync(resolve(root,'apps/desktop/src-tauri/updater-public-key.txt'),'utf8').trim();
if(publicKeyBase64(privateKey)!==raw)throw Error('私钥与程序内置公钥不匹配');
const provenance=JSON.parse(readFileSync(args.provenance,'utf8'));
if(provenance.source_commit!==git('rev-parse','HEAD')||provenance.status!=='passed'||provenance.update_channel!=='workbench')throw Error('缺少新版构建及内置通道核验');
const {envelope,payload}=makeEnvelope({binary,version,notes,privateKey,profile:'workbench',sources:['gitea','github']});
if(provenance.exe_sha256!==payload.artifact.sha256)throw Error('程序与构建核验摘要不符');
const checked=verifyGiteaPackage({envelope,rawKey:Buffer.from(raw,'base64'),binary,notes,version,profile:'workbench'});
const out=resolve(args.out);mkdirSync(out);
writeFileSync(resolve(out,checked.artifact),binary,{flag:'wx'});
writeFileSync(resolve(out,checked.manifest),JSON.stringify(envelope,null,2)+'\n',{flag:'wx'});
writeFileSync(resolve(out,'release-notes.md'),notes,{flag:'wx'});
writeFileSync(resolve(out,'build-provenance.json'),JSON.stringify({...checked,sourceCommit:provenance.source_commit,channelTag:updateProfiles.workbench.channelTag,releaseTag:updateProfiles.workbench.tagPrefix+version,source:'formal-nas-client',published:false},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...checked,prepared:true,published:false}));
