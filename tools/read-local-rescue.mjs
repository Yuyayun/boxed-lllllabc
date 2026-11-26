import fs from 'node:fs/promises';
import { inspect } from 'node:util';
import { readRescueVolume, LOCAL_RESCUE_FORMAT, LOCAL_RESCUE_VERSION } from '../src/storage/local-rescue-format.js';

// Explicit --records prints private chat content to this local terminal only.
const showRecords = process.argv.includes('--records'), files = process.argv.slice(2).filter(item => item !== '--records');
if (!files.length) { console.error('用法：node tools/read-local-rescue.mjs [--records] 救援清单.json 数据卷.json ...'); process.exitCode = 1; }
else try {
  let manifest;
  const parts = new Map();
  for (const file of files) {
    if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('单个救援文件超过读取安全上限。');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.format !== LOCAL_RESCUE_FORMAT || value.version !== LOCAL_RESCUE_VERSION) throw new Error('不是支持的箱装只读救援文件。');
    if (value.type === 'manifest') { if (manifest) throw new Error('一次只能核验一份救援清单。'); manifest = value; continue; }
    const rows = await readRescueVolume(value), key = `${value.exportId}:${value.volume}`;
    if (parts.has(key)) throw new Error('输入了重复的数据卷。');
    parts.set(key, { count: rows.length, digest: value.digest });
    console.log(`第 ${value.volume} 卷校验通过，${rows.length} 条原始记录。`);
    if (showRecords) for (const row of rows) console.log(inspect(row, { depth: null, colors: false, maxArrayLength: null, maxStringLength: null }));
  }
  if (manifest) {
    for (const volume of manifest.volumes) {
      const part = parts.get(`${manifest.exportId}:${volume.volume}`);
      if (!part || part.digest !== volume.digest || part.count !== volume.count) throw new Error(`第 ${volume.volume} 卷缺失或与清单不一致。`);
    }
    if (parts.size !== manifest.volumes.length) throw new Error('包含不属于此清单的数据卷。');
    console.log(`清单核验通过：${parts.size} 卷；扫描状态 ${manifest.status}。这只证明所提供文件一致，不证明历史备份完整，也不能直接导入迁移。`);
  } else console.log('未提供救援清单，不能判断是否齐卷。');
} catch (error) { console.error(`读取救援文件失败：${error.message}`); process.exitCode = 1; }
