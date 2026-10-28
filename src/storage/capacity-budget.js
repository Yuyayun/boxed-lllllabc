// Conservative additional free-space estimate. Existing target bytes already
// occupy the filesystem/quota and must not be charged a second time as free space.
export function migrationSpaceBudget(manifest,mode){
  const bytes=manifest?.bytes,count=manifest?.count??0;
  if(!['indexeddb','sqlite'].includes(mode)||!Number.isSafeInteger(bytes)||bytes<0||!Number.isSafeInteger(count)||count<0)throw new Error('迁移容量清单无效。');
  const payload=bytes*(mode==='sqlite'?3:2),indexes=count*(mode==='sqlite'?12288:4096),reserve=(mode==='sqlite'?32:8)*1024*1024;
  const requiredAdditionalBytes=payload+indexes+reserve;if(!Number.isSafeInteger(requiredAdditionalBytes))throw new Error('迁移容量超过可可靠计算的范围。');
  return {requiredAdditionalBytes,payload,indexes,reserve};
}
