/* Private task control files only. Canonical alias roots are trusted; descendants may not be symlinks. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const DEFAULT_ROOT='/home/coder/worktrees/evyar-cgp/control';
function privatePath(input,{controlRoot=DEFAULT_ROOT,aliasRoot='/tmp/evyar-cgp/control'}={}){
 assert.equal(typeof input,'string');assert.ok(path.isAbsolute(input),'absolute private control path required');assert.ok(!input.split(path.sep).includes('..'),'private path traversal refused');
 assert.ok(fs.lstatSync(controlRoot).isDirectory()&&!fs.lstatSync(controlRoot).isSymbolicLink(),'canonical control root must be real');const root=fs.realpathSync(controlRoot);assert.equal(root,path.resolve(controlRoot),'canonical control root moved');const alias=fs.realpathSync(aliasRoot);assert.equal(alias,root,'task control aliases disagree');
 const lexicalRoots=[path.resolve(controlRoot),path.resolve(aliasRoot)],selected=lexicalRoots.find(base=>input.startsWith(base+path.sep));assert.ok(selected,'private file must be within task control');
 const tail=path.relative(selected,input),parts=tail.split(path.sep);assert.ok(parts.length&&parts.every(p=>p&&p!=='.'&&p!=='..'&&!/^public(?:-|$)/i.test(p)),'public or traversing private path refused');
 assert.match(parts.at(-1),/^private-migration-[a-z0-9-]+\.json(?:\.(?:deploy-private\.log|apply-report\.json))?$/,'dedicated private migration filename required');
 let current=root;for(const part of parts.slice(0,-1)){current=path.join(current,part);const stat=fs.lstatSync(current);assert.ok(stat.isDirectory()&&!stat.isSymbolicLink(),'private parent must be a real directory');}
 const target=path.join(root,...parts);assert.equal(fs.realpathSync(path.dirname(target)),path.dirname(target),'private parent alias refused');return target;
}
function checkFile(target,fd){const stat=fs.fstatSync(fd),entry=fs.lstatSync(target);assert.ok(stat.isFile()&&entry.isFile()&&!entry.isSymbolicLink(),'regular private file required');assert.equal(stat.mode&0o077,0,'private file must have mode0600');assert.equal(stat.mode&0o700,0o600,'private owner mode must be0600');assert.equal(stat.dev,entry.dev);assert.equal(stat.ino,entry.ino,'private file identity changed');return stat;}
function readPrivateFile(input,options){const target=privatePath(input,options),fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{checkFile(target,fd);return fs.readFileSync(fd,'utf8');}finally{fs.closeSync(fd);}}
function readPrivateJson(input,options){try{return JSON.parse(readPrivateFile(input,options));}catch(error){if(error instanceof SyntaxError)throw Error('PRIVATE_JSON_INVALID');throw error;}}
function openFreshPrivateFile(input,options){const target=privatePath(input,options),fd=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);checkFile(target,fd);return{path:target,write(value){checkFile(target,fd);const bytes=Buffer.from(value);fs.ftruncateSync(fd,0);let offset=0;while(offset<bytes.length)offset+=fs.writeSync(fd,bytes,offset,bytes.length-offset,offset);fs.fsyncSync(fd);},discardEmpty(){const stat=checkFile(target,fd);assert.equal(stat.size,0,'only empty owned output can be discarded');fs.unlinkSync(target);},close(){fs.closeSync(fd);}};}
function writeFreshPrivateFile(input,value,options){const file=openFreshPrivateFile(input,options);try{file.write(value);}finally{file.close();}}
module.exports={privatePath,readPrivateFile,readPrivateJson,openFreshPrivateFile,writeFreshPrivateFile};
