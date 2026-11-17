// Authenticate git (clone/push) to a non-GitHub host WITHOUT putting the secret in argv, the URL, the repo's .git/config or a log:
// git reads `GIT_CONFIG_COUNT/KEY_n/VALUE_n` from the environment (git >= 2.31), and the header is scoped to that host's origin only.
export function gitAuthEnv(origin, user, secret) {
  if (!secret) return {};
  return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`, GIT_TERMINAL_PROMPT: '0' };
}
