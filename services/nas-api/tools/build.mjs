// 构建可直接挂载到官方Node镜像的完整程序；不包含业务数据、测试库或凭据。
import {build} from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
const output=process.argv[2];
if(!output)throw Error('请指定仓库外的打包目录');
await mkdir(output,{recursive:true});
const target=resolve(output,'server.mjs');
await build({entryPoints:['src/main.mjs'],outfile:target,bundle:true,platform:'node',format:'esm',target:'node24',external:['pg-native'],banner:{js:"import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);"},legalComments:'eof'});
const bytes=await readFile(target);
await writeFile(resolve(output,'bundle-manifest.json'),JSON.stringify({entry:'server.mjs',nodeMajor:24,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,nativeDriver:false},null,2));
console.log('接口程序已打包，摘要见 bundle-manifest.json');
