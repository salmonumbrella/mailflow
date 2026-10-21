#!/usr/bin/env python3
"""File-only construction. Never invokes Node, npm, Docker, services or tests."""
import argparse,gzip,hashlib,io,json,os,pathlib,tarfile
P=pathlib.Path
HERE=P(__file__).resolve().parent

def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def read(p):return json.loads(p.read_text())
def main():
 a=argparse.ArgumentParser();a.add_argument('--artifacts-root',type=P,required=True);args=a.parse_args();root=args.artifacts_root.resolve(strict=True)
 lock_roots={'frontend':root/'2026-10-21-air-frontend-v9-preflight/dependency-workspace/frontend','backend':root/'2026-10-21-air-backend-preflight/dependency-workspace/backend','mime-tools':root/'2026-10-21-mailparser-tooling/workspace','protocol':root/'2026-10-20-orbstack-e2e/protocol'}
 locks={}
 for kind,folder in lock_roots.items():
  for leaf in ['package.json','package-lock.json']:
   dst=HERE/'locks'/kind/leaf;dst.parent.mkdir(parents=True,exist_ok=True);dst.open('xb').write((folder/leaf).read_bytes());locks[str(dst.relative_to(HERE))]=sha(dst)
 write_locks={'files':locks,'frontendInstalledManifestDifference':'Existing accepted workspace omits only engines metadata from package.json and the root lock entry. All other package/lock JSON equals public source; public source remains unchanged. Exact installed graph bytes are reused, not reinstalled.','runtimeExecuted':False}
 (HERE/'locks.json').open('x').write(json.dumps(write_locks,indent=2)+'\n')
 records={};sources={}
 def add(src,dst,wanted=None):
  assert not src.is_symlink() and src.is_file(),dst
  actual=sha(src);assert wanted is None or actual==wanted, 'Pin mismatch: '+dst
  assert dst not in records and not P(dst).is_absolute() and '..' not in P(dst).parts
  records[dst]={'sha256':actual,'bytes':src.stat().st_size,'mode':0o755 if src.stat().st_mode&0o111 else 0o644};sources[dst]=src
 def group(rel,manifest,field=None):
  d=read(root/rel/manifest);d=d[field] if field else d
  for n,s in d.items():add(root/rel/n,'artifacts/'+rel+'/'+n,s)
  add(root/rel/manifest,'artifacts/'+rel+'/'+manifest)
 orch='2026-10-21-same-app-orchestrator/source-v5'
 assert sha(root/orch/'files.json')=='eb22a5b0f3e6996a82c161e9b57445800a0edf86d282668cd371742bbfa6639a'
 group(orch,'files.json');add(root/orch/'freeze.json','artifacts/'+orch+'/freeze.json')
 add(root/'2026-10-21-same-app-orchestrator/root-source-v5-accepted.json','artifacts/2026-10-21-same-app-orchestrator/root-source-v5-accepted.json')
 app='2026-10-21-final-source-da20';verification=root/app/'root-source-driver-verification.json'
 assert sha(verification)=='1120a40957c99f02b81eefb2f0d559fe98f7237d6a8c62458d883cb72ea513ba'
 add(verification,'artifacts/'+app+'/root-source-driver-verification.json')
 add(root/app/'runtime-app-manifest.json','artifacts/'+app+'/runtime-app-manifest.json','87cfa5307addf2bbbe77c9b1212a9708b43602f5cfd2268a9beddf37704a63c3')
 driver=read(verification)['driverModules'];assert len(driver)==10
 for n,s in driver.items():add(root/app/'driver-code'/n,'artifacts/'+app+'/driver-code/'+n,s)
 group('2026-10-21-wire-pg-profile-successor/source','files.json')
 audit='2026-10-21-actual-pg-prelaunch';group(audit+'/audit','files.json','files')
 add(root/audit/'actual-package-inputs.json','artifacts/'+audit+'/actual-package-inputs.json',read(root/audit/'audit/files.json')['inputManifestSha256'])
 inputs=read(root/audit/'actual-package-inputs.json')['files'];assert len(inputs)==147
 for n,s in inputs.items():add(root/audit/'reference'/n,'artifacts/'+audit+'/reference/'+n,s)
 graphrel='2026-10-21-driver-dependency-join/dependency-graph.proposed.json';graph=read(root/graphrel);add(root/graphrel,'artifacts/'+graphrel)
 dep_roots={
 '/fixture/frontend/node_modules':root/'2026-10-21-air-frontend-v9-preflight/dependency-workspace/frontend/node_modules',
 '/fixture/backend/node_modules':root/'2026-10-21-air-backend-preflight/dependency-workspace/backend/node_modules',
 '/fixture/mime-tools/node_modules':root/'2026-10-21-mailparser-tooling/workspace/node_modules'}
 assert len(graph['files'])==33049 and len(graph['links'])==83
 for e in graph['files']:
  prefix=next(k for k in dep_roots if e['realPath'].startswith(k+'/'));rel=e['realPath'][len(prefix)+1:]
  add(dep_roots[prefix]/rel,'deps/'+prefix.removeprefix('/fixture/')+'/'+rel,e['sha256'])
 fixture=read(root/orch/'fixture-dependency-reference.json');assert len(fixture['files'])==1141 and len(fixture['links'])==2
 fixture_root=root/'2026-10-20-orbstack-e2e/protocol/node_modules'
 for n,s in fixture['files'].items():add(fixture_root/n,'deps/protocol/node_modules/'+n,s)
 links={}
 for e in graph['links']:
  prefix=next(k for k in dep_roots if e['path'].startswith(k+'/'));rel=e['path'][len(prefix)+1:];src=dep_roots[prefix]/rel
  assert src.is_symlink() and os.readlink(src)==e['target'];links['deps/'+e['path'].removeprefix('/fixture/')]=e['target']
 for n,t in fixture['links'].items():
  src=fixture_root/n;assert src.is_symlink() and os.readlink(src)==t;links['deps/protocol/node_modules/'+n]=t
 # Exact closure inventory: reject unpinned files, links or special objects.
 for prefix,dep in list(dep_roots.items())+[('/fixture/protocol/node_modules',fixture_root)]:
  key='deps/'+prefix.removeprefix('/fixture/')
  expected={n[len(key)+1:] for n in records if n.startswith(key+'/')}|{n[len(key)+1:] for n in links if n.startswith(key+'/')}
  actual={str(x.relative_to(dep)) for x in dep.rglob('*') if x.is_symlink() or not x.is_dir()}
  assert actual==expected,'Dependency inventory drift: '+key+' '+str(sorted(actual^expected)[:8])
 for n,t in links.items():
  assert not P(t).is_absolute();resolved=os.path.normpath(str(P(n).parent/t));assert resolved in records,'Unpinned link target '+n
 # Original pinned metadata is retained byte-for-byte. New index has relative paths only.
 manifest={'schema':'mailflow-hosted-arm-bundle-v1','sourceCommit':'76146779946849581b5b26dd35933ebd00fe847d','sourceTree':'726385949110b2d1eef6168fa5765942136b955e','files':records,'links':links,'counts':{'appCheckoutFiles':1496,'driver':10,'wire':25,'pgAuditInputs':147,'driverDependencyFiles':33049,'driverDependencyLinks':83,'fixtureDependencyFiles':1141,'fixtureDependencyLinks':2},'appViaPinnedCheckout':True}
 raw=(json.dumps(manifest,indent=2,sort_keys=True)+'\n').encode();(HERE/'bundle-index.json').open('xb').write(raw)
 tarpath=HERE/'bundle.tar.gz'
 with tarpath.open('xb') as out,gzip.GzipFile(filename='',mode='wb',compresslevel=1,fileobj=out,mtime=0) as gz,tarfile.open(fileobj=gz,mode='w|',format=tarfile.PAX_FORMAT) as tar:
  for name in sorted(records):
   r=records[name];i=tarfile.TarInfo(name);i.size=r['bytes'];i.mode=r['mode'];i.mtime=0
   with sources[name].open('rb') as stream:tar.addfile(i,stream)
  for name,target in sorted(links.items()):
   i=tarfile.TarInfo(name);i.type=tarfile.SYMTYPE;i.linkname=target;i.mode=0o777;i.mtime=0;tar.addfile(i)
 chunks={}
 with tarpath.open('rb') as stream:
  for i,data in enumerate(iter(lambda:stream.read(40*1024*1024),b'')):
   name=f'bundle.part-{i:03}';(HERE/name).open('xb').write(data);chunks[name]={'sha256':sha(HERE/name),'bytes':len(data)}
 receipt={'bundleSha256':sha(tarpath),'bundleBytes':tarpath.stat().st_size,'indexSha256':hashlib.sha256(raw).hexdigest(),'chunks':chunks,'counts':manifest['counts'],'regularFiles':len(records),'links':len(links),'runtimeExecuted':False}
 (HERE/'bundle-receipt.json').open('x').write(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt))
if __name__=='__main__':main()
