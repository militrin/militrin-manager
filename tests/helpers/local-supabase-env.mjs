const LOCAL_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const LOCAL_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

export async function resolveLocalSupabase() {
  const candidates = ['http://127.0.0.1:15421', 'http://127.0.0.1:54321'];
  for (const url of candidates) {
    try {
      const response = await fetch(`${url}/auth/v1/health`);
      if (response.ok) {
        return { url, anonKey: LOCAL_ANON_KEY, serviceKey: LOCAL_SERVICE_KEY };
      }
    } catch {
      // try next local candidate
    }
  }
  throw new Error('Supabase local nao responde em 127.0.0.1:15421 nem :54321');
}
