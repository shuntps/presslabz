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

  'content.type.post.plural': 'Posts',
  'content.type.page.plural': 'Pages',
  'content.column.title': 'Title',
  'content.column.language': 'Language',
  'content.column.updated': 'Updated',
  'content.column.status': 'State',
  'content.count': '{total} total · {drafts} in draft',
  'content.empty': 'Nothing written yet. The first one starts here.',
  'content.gap': 'Gap',
  'content.gapCount': '{count} published here have no version in the other language yet.',
  'content.untranslated': 'No translation',

  'content.new': 'New',
  'content.untitled': 'Untitled',

  'editor.titlePlaceholder': 'Title',
  'editor.blocks': 'Blocks',
  'editor.document': 'Document',
  'editor.block': 'Block',
  'editor.slug': 'Slug',
  'editor.status': 'State',
  'editor.language': 'Language',
  'editor.group': 'Translation group',
  'editor.schema': 'Schema',
  'editor.excerpt': 'Excerpt',
  'editor.publishAt': 'Publish at',
  'editor.save': 'Save',
  'editor.saving': 'Saving…',
  'editor.saved': 'Saved',
  'editor.remove': 'Remove block',
  'editor.moveUp': 'Move up',
  'editor.moveDown': 'Move down',
  'editor.attribution': 'Attribution',
  'editor.language.hint': 'Language hint',
  'editor.ordered': 'Numbered',
  'editor.itemPlaceholder': 'List item',
  'editor.empty': 'An empty document. Add the first block.',
  'block.paragraph': 'Paragraph',
  'block.heading': 'Heading',
  'block.quote': 'Quote',
  'block.list': 'List',
  'block.code': 'Code',
  'block.divider': 'Divider',
  'block.image': 'Image',

  'error.slugTaken': 'That slug is already used in this language',
  'error.translationExists': 'That translation group already has a document in this language',
  'error.cannotPublish': 'You do not have permission to publish',

  'nav.dashboard': 'Dashboard',
  'nav.compose': 'Compose',

  'error.notFound': 'Not found',
  'error.unauthorized': 'You are not signed in',
  'error.forbidden': 'You do not have permission to do that',
  'error.unexpected': 'Something went wrong',
} as const

export type MessageKey = keyof typeof en
export type Messages = Record<MessageKey, string>
