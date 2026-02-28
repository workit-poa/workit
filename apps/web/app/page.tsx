export default function HomePage() {
  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>Proof of Activity</h1>
      <p>Unified fullstack Next.js app for UI, auth, and API routes.</p>
      <ul>
        <li>`/api/health`</li>
        <li>`/api/wallet/[accountId]`</li>
        <li>`/api/auth/register` (POST)</li>
        <li>`/api/auth/login` (POST)</li>
        <li>`/api/auth/oauth/google` (POST)</li>
        <li>`/api/auth/refresh` (POST)</li>
        <li>`/api/auth/logout` (POST)</li>
        <li>`/api/auth/me` (GET, Bearer)</li>
        <li>`/api/protected/profile` (GET, Bearer)</li>
      </ul>
    </main>
  );
}
