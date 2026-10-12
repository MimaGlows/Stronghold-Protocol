import { startServer } from '../server/index.js';
import path from 'node:path';
const data=path.resolve('../qa-data');
const server=await startServer({host:'127.0.0.1',port:3211,quiet:false,replayDir:path.join(data,'replays'),profileDir:path.join(data,'replays/profiles')});
console.log('QA',server.url);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await server.close();process.exit(0);});
