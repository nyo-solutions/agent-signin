// fill_details across frames: card fields often live in a payment provider's iframe
// (e.g. https://js.stripe.com) inside the shop page. Both browser channels list the
// tab's frames and run the fill script in one frame at a time; this decides which
// fields each frame may receive.
//
// frames: [{ ref, origin, top }]  (ref is channel-specific)
// run(frame, req) -> fill-page result, executed in that frame only
// req.frameOrigins: { identity: [origin], card: [origin] }  approved iframe origins per group
export async function fillAcrossFrames(frames, run, req) {
  const top = frames.find((f) => f.top);
  if (!top) throw new Error('could not find the page\'s top frame');
  const groupsFor = (fr) => ['identity', 'card'].filter((g) => fr.origin === req.expectedOrigin || (req.frameOrigins?.[g] || []).includes(fr.origin));
  const order = [top, ...frames.filter((f) => !f.top && f.origin !== 'null' && groupsFor(f).length)];
  let remaining = req.fields;
  const filled = [];
  const where = {};
  for (const fr of order) {
    const groups = groupsFor(fr);
    const mine = remaining.filter((f) => groups.includes(f.group));
    if (!mine.length) continue;
    const r = await run(fr, { ...req, expectedOrigin: fr.origin, fields: mine, submit: false, partial: true });
    if (!r?.ok) {
      if (fr.top) return r; // invalid selector or a wrong input type: stop before going on
      continue; // a provider frame that refuses (e.g. navigated away) is skipped
    }
    for (const k of r.filled) { filled.push(k); if (!fr.top) where[k] = fr.origin; }
    remaining = remaining.filter((f) => !r.filled.includes(f.kind));
  }
  const skipped = remaining.map((f) => f.kind);
  if (!filled.length) return { ok: false, error: 'none of the requested fields were found on the page or its approved frames' };
  let submitted = false;
  let note;
  if (req.submit) {
    const r = await run(top, { ...req, fields: [], submitOnly: true, partial: true });
    submitted = Boolean(r?.submitted);
    note = r?.note || (!r?.ok ? r?.error : undefined);
  }
  return {
    ok: true, origin: req.expectedOrigin, filled, submitted,
    ...(Object.keys(where).length && { filled_in_frames: where }),
    ...(skipped.length && { skipped }),
    ...(note && { note }),
  };
}

export const hasFrames = (req) => Object.values(req.frameOrigins || {}).some((o) => o?.length);
