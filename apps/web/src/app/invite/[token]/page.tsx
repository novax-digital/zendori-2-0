import { redirect } from 'next/navigation';

// The token-based invite/accept flow is retired — admins create accounts
// directly (no public self-registration). Any old invite links land on /login.
export default function InvitePage() {
  redirect('/login');
}
