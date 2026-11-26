from pathlib import Path
import json,hashlib,shutil
V=Path(__file__).resolve().parent
# Run from final2. Only restore the exact approved JS closure, never models or animation files.
W=Path.cwd().resolve();index=json.loads((V/'runtime-sources/SOURCE_INDEX.json').read_text(encoding='utf-8'))
for row in index['files']:
 rel=Path(row['originalRelativePath']);src=(V/row['snapshotFile']).resolve();dst=(W/rel).resolve()
 if not dst.is_relative_to(W)or not src.is_relative_to(V/'runtime-sources')or dst.suffix not in ['.js','.mjs']:raise SystemExit('Unsafe runtime path')
 h=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 if h(src)!=row['sha256']:raise SystemExit('Snapshot hash mismatch')
 if dst.exists():
  if h(dst)!=row['sha256']:raise SystemExit('Refusing to overwrite a different existing runtime file: '+str(rel))
  continue
 dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
print('Verified JS runtime restored. Qualified local asset/provenance pack is still required; no data downloaded.')
