export default function HomePage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>Proof of Activity</h1>
      <p>Unified fullstack Next.js app for UI and API routes.</p>
      <ul>
        <li>`/api/health`</li>
        <li>`/api/session/[userId]`</li>
        <li>`/api/wallet/[accountId]`</li>
      </ul>
    </main>
  );
}
