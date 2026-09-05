import {existsSync} from "node:fs";

/** Owner control lives outside every model-visible case workspace. Holding
 * between cases never pauses an in-flight mission or changes its budget. */
export async function waitBetweenAcceptanceCases({pauseFile,shouldStop,onHold,onRelease,pollMs=1000}) {
  if(!existsSync(pauseFile)||shouldStop())return !shouldStop();
  await onHold();
  while(existsSync(pauseFile)&&!shouldStop())await new Promise(resolve=>setTimeout(resolve,pollMs));
  await onRelease({stopped:shouldStop()});
  return !shouldStop();
}
