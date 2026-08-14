import { spawnSync, type ChildProcess } from "node:child_process";

/**
 * Kill a spawned command and everything it started.
 *
 * Every command Reel runs goes through a shell, so the child is `/bin/sh -c …`
 * or `cmd.exe /d /s /c …` and the thing worth killing is its grandchild.
 * Signalling only the shell leaves that grandchild running, holding the pipes
 * it inherited — which means the recording waits for a command it believes it
 * has already killed.
 *
 * The two platforms have nothing in common here, so they get separate paths
 * rather than one that quietly works on only one of them.
 */
export function killTree(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  if (!child.pid) return;

  if (process.platform === "win32") {
    // Windows has no process groups to signal. `taskkill /T` walks the tree
    // from a pid, and `/F` is required because a console process that isn't
    // pumping messages will not act on a polite request.
    const killed = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    // status 128 is "no such process" — it exited on its own, which is fine.
    if (killed.status === 0 || killed.status === 128) return;
    // taskkill missing from PATH is not something to fail a recording over;
    // the plain kill at least reaps the shell.
  } else {
    try {
      // Negative pid signals the whole group, which works only because the
      // child was spawned detached.
      process.kill(-child.pid, signal);
      return;
    } catch {
      /* already gone, or never became a group leader */
    }
  }

  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}
