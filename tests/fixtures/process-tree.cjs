const {spawn} = require('node:child_process');
const fs = require('node:fs');
if (process.argv[2] === 'leaf') {
  process.on('SIGTERM',()=>{});
  setInterval(()=>{},1000);
} else {
  const leaf = spawn(process.execPath,[__filename,'leaf'],{stdio:'ignore'});
  leaf.once('spawn',()=>fs.writeFileSync(process.env.FIXTURE_PIDS,JSON.stringify({root:process.pid,leaf:leaf.pid})));
  process.on('SIGTERM',()=>{});
  setInterval(()=>{},1000);
}
