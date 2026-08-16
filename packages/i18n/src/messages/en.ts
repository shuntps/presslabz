/**
 * English is the source catalogue: its keys define the type that every other
 * language must satisfy. A missing French string is therefore a compile
 * error, not something discovered in production as a blank label.
 */
export const en = {
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.search': 'Search',
  'common.loading': 'Loading…',

  'theme.label': 'Theme',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',

  'locale.label': 'Language',

  'auth.signIn': 'Sign in',
  'auth.signingIn': 'Signing in…',
  'auth.signOut': 'Sign out',
  'auth.email': 'Email',
  'auth.password': 'Password',
  'auth.invalidCredentials': 'That email and password do not match',
  'auth.tooManyAttempts': 'Too many attempts. Try again later.',
  'auth.tagline': 'Compose, translate, publish.',

  'dashboard.title': 'Dashboard',
  'dashboard.name': 'Name',
  'dashboard.role': 'Role',
  'dashboard.capabilities': 'Capabilities',
  'dashboard.empty': 'There is nothing here yet. Content arrives in the next phase.',

  'content.status.draft': 'Draft',
  'content.status.scheduled': 'Scheduled',
  'content.status.published': 'Published',
  'content.status.archived': 'Archived',
  'content.status.trash': 'Trash',

  'error.notFound': 'Not found',
  'error.unauthorized': 'You are not signed in',
  'error.forbidden': 'You do not have permission to do that',
  'error.unexpected': 'Something went wrong',
} as const

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>
