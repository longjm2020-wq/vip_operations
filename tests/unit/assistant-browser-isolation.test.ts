import { describe,expect,it } from 'vitest';
import { parseBrowserProcessTitle } from '../../apps/worker/src/assistant-browser-isolation.js';

describe('Chromium isolation process-title diagnostics',()=>{
  it('recognizes renderer roles in both NUL-separated argv and Chromium merged argv[0]',()=>{
    for(const raw of [
      '/tmp/browser/chrome-headless-shell\0--type=renderer\0--renderer-client-id=7\0',
      '/tmp/browser/chrome-headless-shell --type=renderer --renderer-client-id=7\0\0',
    ]) expect(parseBrowserProcessTitle(raw)).toEqual({role:'renderer',prohibitedFlags:false});
    expect(parseBrowserProcessTitle('/tmp/chrome-headless-shell --type=utility --disable-seccomp-filter-sandbox\0')).toEqual({role:'utility',prohibitedFlags:true});
    expect(parseBrowserProcessTitle('/tmp/chrome-headless-shell\0--type=zygote\0--no-sandbox=true\0')).toEqual({role:'zygote',prohibitedFlags:true});
  });
  it('requires complete switch boundaries and never treats a normal argument value as a switch',()=>{
    expect(parseBrowserProcessTitle('/tmp/chrome-headless-shell --type=renderer-extra --no-sandbox-extra --disable-namespace-sandbox-extra\0')).toEqual({role:'other',prohibitedFlags:false});
    expect(parseBrowserProcessTitle('/tmp/chrome-headless-shell\0--user-agent=custom --type=renderer --no-sandbox\0')).toEqual({role:'browser',prohibitedFlags:false});
  });
});
