import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {sandboxEnvironment,bioinformaticsEnvironment,toolDeadlineMs} from "../src/main/services/mcp-client.ts";

const profile={version:1,provider:"docker-wsl",image:`quay.io/jupyter/r-notebook@sha256:${"a".repeat(64)}`,wslDistribution:"Ubuntu-24.04",wslUser:"openclaw",wslSocket:"unix:///run/user/1001/docker.sock",wslDockerPath:"/home/openclaw/bin/docker"};
test("persisted workspace sandbox profile is loaded with an exact environment allowlist",t=>{
  const root=mkdtempSync(join(tmpdir(),"proto-sandbox-profile-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,".proto-agent"));writeFileSync(join(root,".proto-agent/sandbox.json"),JSON.stringify(profile));
  const env=sandboxEnvironment({SECRET:"do not forward",PROTO_AGENT_UNSAFE_HOST:"1"},root);
  assert.equal(env.PROTO_AGENT_SANDBOX_PROVIDER,"docker-wsl");
  assert.equal(env.PROTO_AGENT_SANDBOX_WSL_DOCKER_PATH,profile.wslDockerPath);
  assert.equal(env.SECRET,undefined);assert.equal(env.PROTO_AGENT_UNSAFE_HOST,undefined);
  writeFileSync(join(root,".proto-agent/sandbox.json"),JSON.stringify({...profile,unsafe_host:true}));
  assert.throws(()=>sandboxEnvironment({},root),/schema/);
});
test("WSL provider refuses host-root users, shell paths and remote daemons",()=>{
  const env={PROTO_AGENT_SANDBOX_PROVIDER:profile.provider,PROTO_AGENT_SANDBOX_IMAGE:profile.image,PROTO_AGENT_SANDBOX_WSL_DISTRIBUTION:profile.wslDistribution,PROTO_AGENT_SANDBOX_WSL_USER:profile.wslUser,PROTO_AGENT_SANDBOX_WSL_SOCKET:profile.wslSocket};
  assert.throws(()=>sandboxEnvironment({...env,PROTO_AGENT_SANDBOX_WSL_USER:"root"}),/non-root/);
  assert.throws(()=>sandboxEnvironment({...env,PROTO_AGENT_SANDBOX_WSL_SOCKET:"tcp://remote:2375"}),/Unix socket/);
  assert.throws(()=>sandboxEnvironment({...env,PROTO_AGENT_SANDBOX_WSL_DOCKER_PATH:"/bin/sh"}),/Docker executable/);
});
test("bioinformatics forwards only explicit installation paths and has a bounded job deadline",()=>{
  assert.deepEqual(bioinformaticsEnvironment({SECRET:"hidden"}),{});
  const env={PROTO_AGENT_BIO_WSL_DISTRO:"Ubuntu-24.04",PROTO_AGENT_BIO_ROOT:"/home/openclaw/.local/share/proto-bio"};
  assert.deepEqual(bioinformaticsEnvironment({...env,SECRET:"hidden"}),env);
  assert.throws(()=>bioinformaticsEnvironment({...env,PROTO_AGENT_BIO_ROOT:"/home/openclaw/../secrets"}),/traversal/);
  assert.equal(toolDeadlineMs("proto_bioinformatics_run",{}),630000);
});
