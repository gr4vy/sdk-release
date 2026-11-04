import { appendFileSync } from 'node:fs';
import { client } from './github.mjs';
import { decide } from './gate.mjs';

const decision = await decide(client(process.env.GITHUB_TOKEN), {
  repo: process.env.GITHUB_REPOSITORY,
  headSha: process.env.HEAD_SHA,
  bot: process.env.BOT_LOGIN,
  versionSource: process.env.VERSION_SOURCE,
});
console.log(`publish=${decision.publish} mode=${decision.mode ?? '-'}: ${decision.why}`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `publish=${decision.publish}\nmode=${decision.mode ?? ''}\nversion=${decision.version ?? ''}\n`);
}
