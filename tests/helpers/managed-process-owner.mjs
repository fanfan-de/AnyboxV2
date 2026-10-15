import { spawnManagedProcess } from '../../dist/platform/process-runtime.js'

const process_ = spawnManagedProcess({
  executable: process.execPath,
  args: ['-e', `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(JSON.stringify({parent:process.pid,descendant:child.pid}));
    setInterval(()=>{},1000);`],
  cwd: process.cwd(), env: process.env, terminationGraceMs: 100,
})
let output = ''
process_.stdout.on('data', bytes => {
  output += bytes.toString('utf8')
  if (output.includes('\n')) {
    // Fill an unread command pipe. Owner death must still reach the control
    // observer; it cannot wait behind a blocking command stdin write.
    process_.stdin.write(Buffer.alloc(262144, 65), () => {})
    process.send?.(JSON.parse(output.trim()))
  }
})
process_.stderr.resume()
await process_.done
