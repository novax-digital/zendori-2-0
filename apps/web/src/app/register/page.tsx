import { redirect } from 'next/navigation';

// Public self-registration is disabled — accounts are created by admins
// (org owners for their team, Zendori superadmins in /admin).
export default function RegisterPage() {
  redirect('/login');
}
