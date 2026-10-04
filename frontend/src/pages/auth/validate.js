// Client-side checks for instant feedback. The server repeats every one of them (and the password rules) - never trust only this.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const validEmail = (v) => EMAIL.test(v.trim())

/** Name + email + password + confirm (people sign in with their email; no username is asked for). */
export function validateAccount(f) {
  const e = {}
  if (f.full_name.trim().length < 2) e.full_name = 'Enter your full name.'
  if (!validEmail(f.email)) e.email = 'Enter a valid email address.'
  const pw = validatePassword(f.password, f.confirm_password)
  if (pw.password) e.password = pw.password
  if (pw.confirm_password) e.confirm_password = pw.confirm_password
  return e
}

export function validatePassword(password, confirm) {
  const e = {}
  if (!password) e.password = 'Choose a password.'
  else if (password.length < 10) e.password = 'The password must be at least 10 characters long.'
  if (!confirm) e.confirm_password = 'Repeat the password.'
  else if (password !== confirm) e.confirm_password = 'Password and Confirm Password do not match.'
  return e
}
