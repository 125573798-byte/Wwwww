export async function onRequest(context) {
  return new Response(JSON.stringify({ ok: true, path: context.request.url }), {
    headers: { "Content-Type": "application/json" }
  });
}
