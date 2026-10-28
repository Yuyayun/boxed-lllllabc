import test from 'node:test';
import assert from 'node:assert/strict';
import {supervisorProgressText} from '../src/ui/storage-switch.js';
test('监工显示阶段与真实计数，处理数不冒充已核验数',()=>{const text=supervisorProgressText({state:'initializing',stage:'upgrade-copy-verified',count:100,elapsedMs:20000});assert.match(text,/新结构/);assert.match(text,/本阶段已处理 100 条/);assert.doesNotMatch(text,/已读回核对/);assert.match(supervisorProgressText({state:'working',stage:'legacy-verify',verified:0}),/已读回核对 0 条/);});
test('失联和无进展提示优先于旧阶段名称，避免卡住仍显示处理中',()=>{for(const state of ['no-progress','unresponsive','unavailable'])assert.match(supervisorProgressText({state,stage:'legacy-copy'}),/核对|不可用/);});
