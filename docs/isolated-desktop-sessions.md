# Isolated desktop sessions

The candidate desktop supports `--session-root` for a separate local session.
It uses an existing absolute directory and creates `profile/` and `workspace/`
directly inside it. The profile contains the local database and browser session
data; the workspace contains the session's operator-supplied inputs and outputs.

```powershell
New-Item -ItemType Directory -Path 'C:\Research\Example session' -Force
& '.\Proto Workbench.exe' '--session-root=C:\Research\Example session'
```

This option applies to development, unpacked and Portable desktop launches. It
does not seed `Documents/Proto Workbench Workspace`, copy toy materials, load a
model, or relax tool permissions. Supply the workspace inputs using the usual
workspace controls. The explicitly selected session workspace takes precedence
over a previously saved workspace at startup. Reusing the same session directory
reopens its database and artifacts.

Relative paths, filesystem roots, duplicate options, missing root directories,
and redirected profile/workspace child directories are rejected. Do not combine
this option with the development-only `PROTO_WORKBENCH_QA_ROOT` setting.

Candidate package verification prepares an owned session directory under project
`build/`, supplies reviewed test inputs there, and checks the runtime profile and
active workspace paths. Source-level tests of this option do not by themselves
constitute a packaged-launch result; actual package evidence is recorded separately.
