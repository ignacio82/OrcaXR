// Assembly alignment through a binding: every availability, alignment and
// explosion request of the browser's script, compared with the TypeScript
// authority's own encoding. Runs unchanged over WASM in Node and a browser
// worker, and over the JNI bridge.
export function replayAssembly(core, fixture) {
  const counts = { availability: 0, alignment: 0, explosion: 0, planned: 0 };
  for (const [i, step] of fixture.steps.entries()) {
    const [operation, reply] =
      "availability" in step
        ? ["availability", core.assembly_availability(step.availability)]
        : "alignment" in step
          ? ["alignment", core.assembly_alignment(step.alignment)]
          : ["explosion", core.assembly_explosion(step.explosion)];
    if (reply !== step.reply)
      throw Error(`step ${i}: ${reply} !== ${step.reply}`);
    counts[operation]++;
    if (reply.startsWith('{"planned"')) counts.planned++;
  }
  return {
    assemblyAvailability: counts.availability,
    assemblyAlignments: counts.alignment,
    assemblyPlanned: counts.planned,
    assemblyExplosions: counts.explosion,
  };
}
