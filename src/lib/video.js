/**
 * Video consults — Whereby Embedded REST API (native fetch, Node 20+).
 * Docs: https://docs.whereby.com/reference/whereby-rest-api-reference
 *
 * Degrades to a no-op (returns nulls) when WHEREBY_API_KEY is not configured, so
 * the booking/payment path never crashes and simply books without a room.
 *
 * TPG-2020: List-A drugs may only be first-prescribed on a VIDEO consult — a real
 * video room per consult is part of the compliant prescribing flow. Set the env
 * var WHEREBY_API_KEY to enable; until then bookings succeed with no room link.
 */

const EMPTY = { roomId: null, roomUrl: null, hostUrl: null };

// Create a Whereby meeting for an appointment. The room auto-expires 30 min after
// the consult ends so it isn't left open indefinitely.
async function createVideoRoom({ date, timeEnd }) {
  if (!process.env.WHEREBY_API_KEY) {
    // Not an error — feature simply not enabled yet.
    console.log('[Video] WHEREBY_API_KEY not configured — skipping room creation');
    return { ...EMPTY };
  }

  const tzOffset = process.env.PRACTITIONER_TZ_OFFSET || '+05:30';
  const endDate = new Date(`${date}T${timeEnd}:00${tzOffset}`);
  if (!Number.isFinite(endDate.getTime())) {
    console.error('[Video] invalid date/time for room creation:', date, timeEnd);
    return { ...EMPTY };
  }
  endDate.setMinutes(endDate.getMinutes() + 30);

  try {
    const res = await fetch('https://api.whereby.dev/v1/meetings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.WHEREBY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        endDate: endDate.toISOString(),
        fields: ['hostRoomUrl'],
        roomMode: 'normal',
        roomNamePrefix: 'tac-consult',
      }),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error('[Video] Whereby create failed:', res.status, err);
      return { ...EMPTY };
    }
    const data = await res.json();
    return {
      roomId:  data.meetingId || null,
      roomUrl: data.roomUrl || null,
      hostUrl: data.hostRoomUrl || data.roomUrl || null,
    };
  } catch (err) {
    console.error('[Video] Whereby error:', err.message);
    return { ...EMPTY };
  }
}

// Delete a Whereby meeting (on cancel). Best-effort — never throws.
async function deleteVideoRoom(roomId) {
  if (!process.env.WHEREBY_API_KEY || !roomId) return;
  try {
    await fetch(`https://api.whereby.dev/v1/meetings/${encodeURIComponent(roomId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.WHEREBY_API_KEY}` },
    });
  } catch (err) {
    console.error('[Video] Whereby delete error:', err.message);
  }
}

module.exports = { createVideoRoom, deleteVideoRoom };
