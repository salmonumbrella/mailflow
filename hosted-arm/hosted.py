#!/usr/bin/env python3
"""Dedicated ARM adapter for the unchanged, Root-reviewed source-v8 orchestrator."""
import argparse,datetime,hashlib,importlib.util,json,os,pathlib,platform,re,shutil,signal,stat,subprocess,sys,tarfile,tempfile,time
from urllib.parse import quote
P=pathlib.Path
HERE=P(__file__).resolve().parent
PHASE='arguments'
REPORT_STATE=None
SOURCE='76146779946849581b5b26dd35933ebd00fe847d'
TREE='726385949110b2d1eef6168fa5765942136b955e'
ORCH='44f26228faf45d1c88eee5cb56c7166572bb764a478162e667a0903b2f20b4ed'
VERIFY='1120a40957c99f02b81eefb2f0d559fe98f7237d6a8c62458d883cb72ea513ba'
APP='2026-10-21-final-source-da20'
ORCHESTRATOR_DIR='2026-10-21-same-app-orchestrator/source-v8'

def sha(p):
 h=hashlib.sha256()
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()
def read(p):return json.loads(P(p).read_text())
def pinned_repo_digest_matches(spec,actual):
 # Docker Hub's public-library spelling varies in RepoDigests. The digest,
 # owner and image name remain exact; unrelated registries/owners never match.
 prefix='docker.io/library/'
 repository=spec['repository'];digest=spec['armManifestDigest']
 if not repository.startswith(prefix) or not re.fullmatch(r'sha256:[a-f0-9]{64}',digest):return False
 name=repository[len(prefix):]
 if not re.fullmatch(r'[a-z0-9][a-z0-9._-]*',name) or spec['pullRef']!=repository+'@'+digest:return False
 allowed={repository+'@'+digest,'library/'+name+'@'+digest,name+'@'+digest}
 return isinstance(actual,list) and any(value in allowed for value in actual)

def failure_diagnostics(private,runs):
 # Read only known controller logs. Redact complete files before truncating:
 # cutting a raw log first could expose part of a generated credential.
 try:
  hidden={str(private):'[private]'}
  def hide(value):
   if isinstance(value,dict):
    for item in value.values():hide(item)
   elif isinstance(value,list):
    for item in value:hide(item)
   elif isinstance(value,str) and value:
    for variant in [value,quote(value,safe=''),json.dumps(value)[1:-1]]:hidden[variant]='[redacted]'
  for run in runs:
   credentials=run/'credentials.json'
   if credentials.exists():hide(read(credentials))
  candidates=[private/'orchestrator.stdout',private/'orchestrator.stderr']
  candidates+=sorted(private.glob('preflight-*.stderr'))
  for run in runs:
   candidates += [run/name for name in ['bootstrap-controller.log','bootstrap-backend.log','component-driver.tap.log']]
   candidates += sorted(run.glob('command-*.stderr'))
  result=[]
  for file in candidates:
   if not file.is_file() or not file.stat().st_size:continue
   if file.stat().st_size>2097152:
    result.append({'file':file.name,'omitted':'over private diagnostic size limit'});continue
   text=file.read_text(errors='replace')
   for value in sorted(hidden,key=len,reverse=True):text=text.replace(value,hidden[value])
   text=re.sub(r'(?i)\b(?:authorization|set-cookie|cookie)\s*[:=][^\r\n]*','[redacted-header]',text)
   text=re.sub(r'(?:s%3A|s:)[A-Za-z0-9._%+/-]{16,}','[redacted-cookie]',text)
   text=re.sub(r'(?i)\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b','[synthetic-id]',text)
   assert all(value not in text for value in hidden)
   result.append({'file':file.name,'redactedTail':text[-12000:]})
  return result
 except Exception:
  return [{'omitted':'diagnostic redaction failed; raw logs remain private'}]
def write(p,value):
 with P(p).open('x') as f:json.dump(value,f,indent=2);f.write('\n')
 os.chmod(p,0o600)
def checked_path(name):
 p=P(name);assert not p.is_absolute() and '..' not in p.parts;return p

def packet_guard():
 m=read(HERE/'manifest.json')
 for n,s in m['files'].items():assert sha(HERE/checked_path(n))==s,'Packet drift: '+n
 return m

def bundle_guard():
 receipt=read(HERE/'bundle-receipt.json');assert sha(HERE/'bundle-index.json')==receipt['indexSha256']
 h=hashlib.sha256()
 for n,r in receipt['chunks'].items():
  p=HERE/checked_path(n);assert p.stat().st_size==r['bytes'] and sha(p)==r['sha256'],'Bundle chunk drift'
  with p.open('rb') as f:
   for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 assert h.hexdigest()==receipt['bundleSha256']
 return receipt,read(HERE/'bundle-index.json')

def unpack(private,index,receipt):
 archive=private/'bundle.tar.gz'
 with archive.open('xb') as out:
  for n in receipt['chunks']:
   with (HERE/n).open('rb') as f:shutil.copyfileobj(f,out)
 target=private/'bundle';target.mkdir(mode=0o700)
 seen=set()
 # No extractall: no filesystem write can traverse an archive-provided link.
 with tarfile.open(archive,'r:gz') as tar:
  for item in tar:
   name=item.name;checked_path(name);assert name not in seen;seen.add(name)
   if item.issym():assert index['links'].get(name)==item.linkname;continue
   r=index['files'][name];assert item.isfile() and item.size==r['bytes']
   p=target/name;p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
   with tar.extractfile(item) as src,p.open('xb') as dst:shutil.copyfileobj(src,dst)
   assert sha(p)==r['sha256'];p.chmod(r['mode'])
 assert seen==set(index['files'])|set(index['links'])
 for name,t in index['links'].items():
  assert not P(t).is_absolute();p=target/name
  p.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
  resolved=(p.parent/t).resolve(strict=True)
  assert resolved.is_relative_to(target) and str(resolved.relative_to(target)) in index['files']
  p.symlink_to(t)
 archive.unlink()
 return target

def command(argv,env,private,timeout=60):
 r=subprocess.run([str(x) for x in argv],env=env,capture_output=True,timeout=timeout)
 # Raw service/runtime errors are owner-private; never emitted into Actions logs.
 n=len(list(private.glob('preflight-*.stderr')))
 (private/f'preflight-{n}.stderr').write_bytes(r.stderr)
 assert r.returncode==0,'Preflight command failed (private stderr retained)'
 return r.stdout.decode()

def source_guard(source,env,private,flat):
 assert command(['git','-C',source,'rev-parse','HEAD'],env,private).strip()==SOURCE
 assert command(['git','-C',source,'rev-parse','HEAD^{tree}'],env,private).strip()==TREE
 assert not command(['git','-C',source,'status','--porcelain','--untracked-files=all'],env,private).strip()
 assert len(flat['files'])==1496
 for n,s in flat['files'].items():
  p=source/checked_path(n);assert not p.is_symlink() and sha(p)==s,'App checkout byte drift: '+n

# This invokes only the accepted Python cleanup helper with a discovered,
# task-private random run label; it does not import any Node/product code.
def cleanup(state):
 record=read(state/'private-state.json');private=P(record['privateRoot']);bundle=private/'bundle'
 support=bundle/'artifacts'/ORCHESTRATOR_DIR/'support.py';assert sha(bundle/'artifacts'/ORCHESTRATOR_DIR/'files.json')==ORCH
 assert sha(support)==read(bundle/'artifacts'/ORCHESTRATOR_DIR/'files.json')['support.py']
 spec=importlib.util.spec_from_file_location('owned_v4_support',support);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 results=[]
 for run in sorted((private/'runs').glob('mailflow-*')):
  match=re.fullmatch(r'mailflow-([a-f0-9]{20})-.+',run.name);assert match
  logs=P(tempfile.mkdtemp(prefix='fallback-'+run.name+'-',dir=private))
  docker=module.Docker(record['dockerExecutable'],record['dockerSocket'],match[1],logs)
  failures=docker.cleanup();results.append({'runId':match[1],'cleanupFailures':len(failures),'receiptSha256':sha(logs/'cleanup.json')})
 write(state/f'fallback-cleanup-{time.time_ns()}.json',{'runs':results,'pass':all(x['cleanupFailures']==0 for x in results)})
 assert all(x['cleanupFailures']==0 for x in results),'Owned cleanup failed'

def observed_lease(bundle,private,inputs,policy,observations):
 # Root's reviewed release authorizes this exact code to compose a lease ONLY
 # from the current host/image/path observations. No pre-populated account IDs.
 assert policy['runtimeReleased'] is True and policy['mode']=='small'
 assert policy['sourceCommit']==SOURCE and policy['sourceTree']==TREE
 assert policy['orchestratorManifestSha256']==ORCH and policy['driverSourceVerificationSha256']==VERIFY
 assert sha(bundle/'artifacts'/ORCHESTRATOR_DIR/'files.json')==ORCH
 assert sha(bundle/'artifacts'/APP/'root-source-driver-verification.json')==VERIFY
 accepted=read(bundle/'artifacts/2026-10-21-same-app-orchestrator/root-source-v8-accepted.json')
 assert accepted['orchestratorManifestSha256']==ORCH and accepted['driverSourceVerificationSha256']==VERIFY
 assert accepted['runtimeReleased'] is False # source review is not a runtime grant
 assert observations['uid']==os.getuid()>0 and observations['gid']==os.getgid()
 assert observations['arch']=='aarch64' and observations['platform']=='Linux'
 assert set(observations['images'])=={'node','postgres','redis'}
 deadline=policy['deadlineMs'];ttl=policy['leaseSeconds'];assert 0<deadline<=1200000 and deadline/1000+120<=ttl<=1800
 expiry=datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=ttl)
 graph=bundle/'artifacts/2026-10-21-driver-dependency-join/dependency-graph.proposed.json'
 wire=bundle/'artifacts/2026-10-21-wire-pg-profile-successor/source/files.json'
 audit=bundle/'artifacts/2026-10-21-actual-pg-prelaunch/audit/files.json'
 lease={'lease':'vault#zr11','task':'vault#3hgk','sourceCommit':SOURCE,'sourceTree':TREE,'corpusMode':'small',
 'expiresAt':expiry.isoformat(),'runtimeReleaseGranted':True,'authorizeObservedBindingComposition':True,
 'orchestratorManifestSha256':ORCH,'driverSourceVerificationSha256':VERIFY,'inputsSha256':sha(inputs),
 'wireSourceManifestSha256':sha(wire),'dependencySourceGraphSha256':sha(graph),'pgAuditManifestSha256':sha(audit),
 'deadlineMs':deadline,'backendNodeEnv':'development','limits':policy['limits'],
 'rootReleasePolicySha256':sha(HERE/'release-policy.json'),'actualHostObservationsSha256':sha(private/'observations.json')}
 limits=lease['limits'];assert sum(limits[k] for k in ['nodeCpus','pgCpus','redisCpus'])<=limits['maxTotalCpus']<=observations['cpus']
 assert sum(limits[k] for k in ['nodeMemoryMiB','pgMemoryMiB','redisMemoryMiB'])<observations['memoryMiB']-2048
 assert observations['freeDiskBytes']>=limits['minimumFreeDiskBytes']
 write(private/'lease.json',lease);return private/'lease.json'

def main():
 global PHASE,REPORT_STATE
 PHASE='packet-verification'
 a=argparse.ArgumentParser();a.add_argument('--source',type=P);a.add_argument('--state',type=P,required=True);a.add_argument('--verify-only',action='store_true');a.add_argument('--cleanup-only',action='store_true');a.add_argument('--execute-reviewed',action='store_true');args=a.parse_args()
 os.umask(0o077);packet_guard()
 state=args.state.resolve()
 if args.cleanup_only:
  if (state/'private-state.json').exists():cleanup(state)
  return 0
 PHASE='bundle-hashes'
 receipt,index=bundle_guard()
 if args.verify_only:
  print(json.dumps({'status':'STATIC_BUNDLE_HASHES_VERIFIED_NO_DAEMON','counts':index['counts']}));return 0
 assert args.execute_reviewed and read(HERE/'release-policy.json')['runtimeReleased'] is True,'Root runtime release missing'
 assert os.getuid()>0 and platform.system()=='Linux' and platform.machine()=='aarch64'
 assert os.environ.get('GITHUB_REPOSITORY')=='salmonumbrella/mailflow' and os.environ.get('GITHUB_RUN_ATTEMPT')=='1'
 assert os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
 assert not state.exists(),'No retries or reuse of a previous attempt'
 PHASE='private-state-creation'
 state.mkdir(mode=0o700,parents=True);REPORT_STATE=state;private=P(tempfile.mkdtemp(prefix='mailflow-arm-',dir=state.parent)).resolve()
 private.chmod(0o700);(private/'home').mkdir();(private/'docker-config').mkdir();(private/'runs').mkdir(mode=0o700)
 env={'PATH':'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin','HOME':str(private/'home'),'LANG':'C.UTF-8','DOCKER_CONFIG':str(private/'docker-config')}
 # Exact reuse requires no npm at all. Any future install is a new reviewed binding.
 for name in ['user.npmrc','global.npmrc']:(private/name).open('xb').close();(private/name).chmod(0o600)
 PHASE='host-tools'
 docker=P(shutil.which('docker',path=env['PATH'])).resolve(strict=True);socket=P('/var/run/docker.sock').resolve(strict=True)
 assert stat.S_ISSOCK(socket.stat().st_mode)
 PHASE='bundle-unpack'
 bundle=unpack(private,index,receipt);write(state/'private-state.json',{'privateRoot':str(private),'dockerExecutable':str(docker),'dockerSocket':str(socket)})
 images={};observations={};image_observations={};child=None;exitcode=1;failure=None
 def interrupted(signum,frame):raise InterruptedError('Hosted execution interrupted')
 signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGINT,interrupted)
 try:
  PHASE='host-resources'
  cpus=os.cpu_count();mem=int(re.search(r'MemTotal:\s+(\d+)',P('/proc/meminfo').read_text()).group(1))//1024
  assert cpus>=4 and mem>=12288 and shutil.disk_usage(private).free>=6*1024**3
  flat=read(bundle/'artifacts'/APP/'runtime-app-manifest.json');source=args.source.resolve(strict=True)
  source_guard(source,env,private,flat)
  frozen=bundle/'artifacts'/APP/'frozen/source';frozen.mkdir(mode=0o700,parents=True)
  for n in flat['files']:
   target=frozen/n;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source/n,target)
  PHASE='immutable-images'
  specs=read(HERE/'images.json')['images']
  for name,spec in specs.items():
   command([docker,'--host','unix://'+str(socket),'pull','--platform','linux/arm64',spec['pullRef']],env,private,180)
   item=json.loads(command([docker,'--host','unix://'+str(socket),'image','inspect',spec['pullRef']],env,private))[0]
   checks={'imageId':item['Id'] in [spec['configDigest'],spec['armManifestDigest']],
    'platform':item['Os']=='linux' and item['Architecture']=='arm64',
    'rootfsDiffIds':item['RootFS']['Layers']==spec['rootfsDiffIds'],
    'repoDigest':pinned_repo_digest_matches(spec,item['RepoDigests']),
    'versionEnvironment':all(v in item['Config']['Env'] for v in spec['versionEnvironment'])}
   keys={v.partition('=')[0] for v in spec['versionEnvironment']}
   image_observations[name]={'requestedImmutablePullRef':spec['pullRef'],'imageId':item['Id'],
    'repoDigests':item['RepoDigests'],'platform':item['Os']+'/'+item['Architecture'],
    'rootfsDiffIds':item['RootFS']['Layers'],
    'versionEnvironment':[v for v in item['Config']['Env'] if v.partition('=')[0] in keys],'checks':checks}
   assert all(checks.values()),'Pinned image identity check failed'
   images[name]={'id':item['Id'],'manifestDigest':spec['armManifestDigest'],'configDigest':spec['configDigest'],'platform':'linux/arm64'}
  openssl=P(shutil.which('openssl',path=env['PATH'])).resolve(strict=True)
  command([openssl,'version'],env,private)
  observations={'uid':os.getuid(),'gid':os.getgid(),'platform':platform.system(),'arch':platform.machine(),'cpus':cpus,
   'memoryMiB':mem,'freeDiskBytes':shutil.disk_usage(private).free,'images':images,
   'hostNamespaces':{n:os.readlink('/proc/self/ns/'+n) for n in ['mnt','net','pid','user']},
   'dockerExecutableSha256':sha(docker),'opensslSha256':sha(openssl)}
  write(private/'observations.json',observations)
  roots={p:{'hostRoot':str((bundle/'deps'/p.removeprefix('/fixture/')).resolve(strict=True)),'targetRelative':p.removeprefix('/fixture/')} for p in ['/fixture/frontend/node_modules','/fixture/backend/node_modules','/fixture/mime-tools/node_modules']}
  inputs={'artifactsRoot':str(bundle/'artifacts'),'privateRoot':str(private/'runs'),'dockerExecutable':str(docker),'dockerSocket':str(socket),
   'nodeImageId':images['node']['id'],'pgImageId':images['postgres']['id'],'redisImageId':images['redis']['id'],
   'redisVersion':'7.4.11','fixtureDependencyRoot':str(bundle/'deps/protocol/node_modules'),'opensslExecutable':str(openssl),
   'opensslSha256':sha(openssl),'dependencyRoots':roots}
  PHASE='observed-lease'
  write(private/'inputs.json',inputs);lease=observed_lease(bundle,private,private/'inputs.json',read(HERE/'release-policy.json'),observations)
  write(state/'preflight.json',{'status':'OBSERVED_PROFILE_LEASE_ISSUED','sourceCommit':SOURCE,'sourceTree':TREE,'images':images,
   'uid':observations['uid'],'gid':observations['gid'],'cpus':cpus,'memoryMiB':mem,'freeDiskBytes':observations['freeDiskBytes'],
   'inputsSha256':sha(private/'inputs.json'),'leaseSha256':sha(lease),'expiresAt':read(lease)['expiresAt'],
   'driverSourceVerificationSha256':VERIFY,'orchestratorManifestSha256':ORCH,'supplementalOnly':True})
  # Runtime stdout, TAP, service errors and generated credentials stay private.
  PHASE='same-app-orchestrator'
  with (private/'orchestrator.stdout').open('xb') as stdout,(private/'orchestrator.stderr').open('xb') as stderr:
   blocked=signal.pthread_sigmask(signal.SIG_BLOCK,{signal.SIGTERM,signal.SIGINT})
   try:child=subprocess.Popen([sys.executable,'-B',str(bundle/'artifacts'/ORCHESTRATOR_DIR/'run.py'),'--inputs',str(private/'inputs.json'),'--lease',str(lease),'--mode','small'],env=env,stdout=stdout,stderr=stderr,start_new_session=True,preexec_fn=lambda:signal.pthread_sigmask(signal.SIG_SETMASK,blocked))
   finally:signal.pthread_sigmask(signal.SIG_SETMASK,blocked)
   exitcode=child.wait(timeout=read(HERE/'release-policy.json')['leaseSeconds']+30)
  assert exitcode==0,'Orchestrator reported failure'
  source_guard(source,env,private,flat)
 except BaseException as error:failure=type(error).__name__
 finally:
  signal.signal(signal.SIGTERM,signal.SIG_IGN);signal.signal(signal.SIGINT,signal.SIG_IGN)
  if child is not None and child.poll() is None:
   os.killpg(child.pid,signal.SIGTERM)
   try:child.wait(timeout=35)
   except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL);child.wait(timeout=10)
  try:cleanup(state)
  except BaseException:failure='OwnedCleanupFailure'
  runs=list((private/'runs').glob('mailflow-*'));summaries=[]
  for run in runs:
   original=read(run/'cleanup.json') if (run/'cleanup.json').exists() else None
   if original is None or original['failures']:failure=failure or 'OriginalCleanupMissingOrFailed'
   verdict=read(run/'actual-verdict.json') if (run/'actual-verdict.json').exists() else None
   driver=read(run/'driver-result.json') if (run/'driver-result.json').exists() else None
   tap=run/'component-driver.tap.log';taptext=tap.read_text(errors='replace') if tap.exists() else ''
   native={}
   for key in ['tests','suites','pass','fail','cancelled','skipped','todo']:
    values=re.findall(r'^# '+key+r' (\d+)\s*$',taptext,re.M)
    native[key]=int(values[-1]) if values else None
   summaries.append({'componentExit':verdict['componentExit'] if verdict else None,'nativeTapCounts':native,
    'cases':[{'rawThreadWasNull':c['rawThreadWasNull'],'outcome':c['outcome'],'refusal':c['refusal']} for c in driver['cases']] if driver else [],
    'evidenceSha256':[e['sha256'] for e in verdict['nativeEvidence']] if verdict else [],
    'ownedBackendStopped':driver.get('ownedBackendStopped') if driver else None,
    'cleanup':{'receiptSha256':sha(run/'cleanup.json'),'failures':original['failures'],
     'containerStates':[{'id':c['id'],'before':{k:c['beforeStopState'].get(k) for k in ['Running','ExitCode','OOMKilled']},
      'removedState':{k:c['preRemovalState'].get(k) for k in ['Running','ExitCode','OOMKilled']}} for c in original['containerStates']],
     'postRemovalAbsence':original['postRemovalAbsence']} if original else None})
  passed=failure is None and exitcode==0 and len(summaries)==1
  write(state/'result.json',{'status':'PASS' if passed else 'FAIL','orchestratorExit':child.returncode if child is not None else None,'orchestratorStarted':child is not None,'imagePreflight':image_observations,'failureType':failure,'sourceCommit':SOURCE,'sourceTree':TREE,
   'mode':'small','backendNodeEnv':'development','supplementalOnly':True,'Mini108kProviderBrowserPerformanceAccepted':False,'failurePhase':PHASE if failure else None,'runs':summaries,
   'failureDiagnostics':failure_diagnostics(private,runs) if not passed else []})
 return 0 if passed else 1
if __name__=='__main__':
 try:sys.exit(main())
 except Exception as e:
  error={'status':'FAILED_WITHOUT_ACCEPTANCE','errorType':type(e).__name__,'failurePhase':PHASE,'errno':getattr(e,'errno',None),'sourceCommit':SOURCE,'sourceTree':TREE,'supplementalOnly':True,'Mini108kProviderBrowserPerformanceAccepted':False}
  # Early filesystem/tool failures happen before the orchestrator or services.
  # Persist only fixed metadata; never raw exception text, paths or credentials.
  if REPORT_STATE is not None and REPORT_STATE.is_dir() and not (REPORT_STATE/'result.json').exists():
   try:write(REPORT_STATE/'result.json',error)
   except Exception:pass
  print(json.dumps(error));sys.exit(1)
