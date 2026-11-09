/** Writes `done` to the file `COMPILED_APP_OUT` names, from a step. */
export async function recordGreeting(_event: unknown) {
  "use workflow";
  await record();
}

async function record() {
  "use step";
  await Bun.write(process.env.COMPILED_APP_OUT!, "done");
}
