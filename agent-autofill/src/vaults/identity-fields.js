// Identity fields agent-autofill can fill. Government IDs (SSN, passport,
// licence numbers) are deliberately absent and never read.
export const IDENTITY_FIELDS = [
  'first_name', 'last_name', 'full_name', 'email', 'username', 'phone', 'company',
  'address1', 'address2', 'city', 'state', 'postal_code', 'country',
];

export function fromBitwarden(i = {}) {
  const v = (x) => (x == null || x === '' ? undefined : String(x));
  const full = [i.firstName, i.middleName, i.lastName].filter(Boolean).join(' ');
  return {
    first_name: v(i.firstName), last_name: v(i.lastName), full_name: v(full), email: v(i.email),
    username: v(i.username), phone: v(i.phone), company: v(i.company), address1: v(i.address1),
    address2: v(i.address2), city: v(i.city), state: v(i.state), postal_code: v(i.postalCode), country: v(i.country),
  };
}
