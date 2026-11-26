export type AppEvidence = {
  httpStatus: number | null;
  sub: string | null;
  logoutReceipts: number;
};

export type PreviewState = {
  a: AppEvidence;
  b: AppEvidence;
  loginPrompts: number;
  outcome: 'ready' | 'a-signed-in' | 'b-reused-session' | 'b-needs-login' | 'logged-out' | 'logout-receiver-unavailable';
};

export type Command = {
  action: 'sign-in-a' | 'open-b' | 'logout' | 'reset';
  simulateUnavailableB?: boolean;
};

export function initialState(): PreviewState {
  const unvisited = { httpStatus: null, sub: null, logoutReceipts: 0 };
  return { a: { ...unvisited }, b: { ...unvisited }, loginPrompts: 0, outcome: 'ready' };
}
