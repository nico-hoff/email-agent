export function GET(): Response {
  return new Response('{"status":"ok"}', {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
