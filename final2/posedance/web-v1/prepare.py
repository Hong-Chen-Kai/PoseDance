from pathlib import Path
import json,hashlib,subprocess,os
W=Path.cwd();C=W/'SMPL/local_data/computational_dancer';R=C/'run-20261126-web-v1';V=W/'posedance/web-v1'
j=lambda p:json.loads(Path(p).read_text(encoding='utf-8-sig'))
def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
pins={}
def pin(p,expected=None):
 p=Path(p).resolve();h=sha(p)
 if expected:assert h==expected,str(p)
 pins[str(p)]=h;return str(p)
def chk(ref):return pin(ref['file'],ref['sha256'])
closepath=C/'run-20261126-breaking-bpm-final01/TEN_STYLE_BPM_CLOSEOUT.json';close=j(closepath);pin(closepath);current=j(C/'POPPING_CURRENT.json');pin(C/'POPPING_CURRENT.json')
M3=C/'run-20261125-music03-tempo01';B7=C/'run-20261125-bpm07-ending01';specs=[]
runs=dict(breaking='run-20261126-breaking-bpm01',krump='run-20261125-krump-bpm01',la='run-20261125-la-bpm01',locking='run-20261125-locking-bpm01',street='run-20261125-street-bpm01',ballet='run-20261125-ballet-bpm01',waack='run-20261125-waack-bpm01',middle='run-20261125-middle-continuous01',popping='run-20261126-popping-diversity03',house='run-20261125-bpm07-ending01')
for s in close['styles']:
 style=s['style'];run=C/runs[style];formals=[chk(p)for p in s['qualificationRecords']+s['registryRecords']+s['humanAcceptanceRecords']];g=chk(s['formalGraph']);reg=chk(s['formalRegistry']);version=s['graphVersion']
 item=dict(style=style,label=s['display'],version=version,formalGraph=g,formalRegistry=reg,formalEvidence=formals,run=str(run),kind='generic')
 if style=='popping':
  fq=j(chk(current['qualification']));item.update(version='4.0.0',formalGraph=chk(current['graph']),formalRegistry=chk(current['registry']),formalEvidence=[chk(current[k])for k in ['qualification','registry','archiveSeal']],manifest=chk(fq['poolManifest']),qualification=pin(run/'QUALIFICATION.json'),timeFile=pin(run/'music/source-time.mjs'),ending=pin(run/'ENDING_CANDIDATE.json'),kind='popping')
 elif style=='house':
  source=j(pin(B7/'HOUSE_SOURCE_BINDING.json'));item.update(manifest=pin(Path(source['directory'])/'playlist-assets/manifest.json',source['manifestSHA']),kind='house',houseSource=source)
  item['files']={n:pin(B7/n)for n in ['house-qualified-route.json','qualified-profile.json','tempo-qualification.json','low-tempo-qualification.json','HOUSE_TEMPO_REGISTRY.json','continuous-qualification.json','route7.json','extended-manifest.json','qualification7.json','ENDING_CANDIDATE.json','candidate-route.json','candidate-qualification.json']}
 else:
  gp=Path(g).parent;item['manifest']=pin(gp/'playlist-assets/manifest.json')
  q=run/'QUALIFICATION.json';q=Path(j(q)['parentQualification']['file'])if style in ['ballet','waack']else q
  item.update(qualification=pin(q),timeFile=pin(run/'music/source-time.mjs'if (run/'music/source-time.mjs').exists()else M3/'music/source-time.mjs'),ending=pin((C/'run-20261125-middle-ready01'if style=='middle'else run)/'ENDING_CANDIDATE.json'))
 specs.append(item)
# Pin the immutable runtime/math/renderer files as they are linked; graph assets are checked by build/server.
for root in [M3/'music',B7/'viewer',W/'posedance/experiments/music-sync-lab']:
 for p in root.glob('*'):
  if p.is_file()and p.suffix in ['.js','.mjs']:pin(p)
for item in specs:
 m=j(item['manifest']);base=Path(item['manifest']).parent
 for c in m['chunks']+[m['topology']]:pin(base/c['file'],c['sha256'])
 if item['kind']=='house':
  extra=j(item['files']['extended-manifest.json'])
  for c in extra['chunks'][len(m['chunks']):]:pin(B7/'ending-assets'/c['file'],c['sha256'])
 if item['kind']=='popping':routes=j(item['qualification'])['routes'].values();routes=[{'graphFile':str(itempath:=Path(item['qualification']).parent/r['graph']),'graphSHA':r['graphSHA']}for r in routes]
 elif item['kind']=='generic':routes=[r['strict']for r in j(item['qualification'])['routes'].values()if 'strict'in r]
 else:routes=[]
 for r in routes:pin(r['graphFile'],r['graphSHA'])
env=dict(os.environ,GIT_OPTIONAL_LOCKS='0');cmd=['git','-c','safe.directory=D:/暨南/dance'];head=subprocess.check_output(cmd+['rev-parse','HEAD'],env=env).decode().strip();diff=subprocess.check_output(cmd+['diff','--no-ext-diff'],env=env)
(R/'BASELINE.json').write_text(json.dumps(dict(head=head,trackedDiffSHA=hashlib.sha256(diff).hexdigest(),pins=pins),ensure_ascii=False,indent=2),encoding='utf-8')
(R/'STYLE_BINDINGS.json').write_text(json.dumps(dict(version='1.0.0',styles=specs,historicalCloseout=str(closepath),currentPoppingReference=str(C/'POPPING_CURRENT.json')),ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(dict(styles=[(x['style'],x['version'])for x in specs],pins=len(pins),env='Node browser integration; requested PoseDance Conda not installed, no environment rebuild or Python SMPL calculation needed'),ensure_ascii=False))
