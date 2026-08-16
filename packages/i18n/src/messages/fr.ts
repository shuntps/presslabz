import type { Messages } from './en.ts'

/** Typed as Messages, so an omitted key fails typecheck. */
export const fr: Messages = {
  'common.save': 'Enregistrer',
  'common.cancel': 'Annuler',
  'common.delete': 'Supprimer',
  'common.search': 'Rechercher',
  'common.loading': 'Chargement…',

  'theme.label': 'Thème',
  'theme.light': 'Clair',
  'theme.dark': 'Sombre',
  'theme.system': 'Système',

  'locale.label': 'Langue',

  'content.status.draft': 'Brouillon',
  'content.status.scheduled': 'Planifié',
  'content.status.published': 'Publié',
  'content.status.archived': 'Archivé',
  'content.status.trash': 'Corbeille',

  'error.notFound': 'Introuvable',
  'error.unauthorized': 'Vous n’êtes pas connecté',
  'error.forbidden': 'Vous n’avez pas la permission de faire cela',
  'error.unexpected': 'Une erreur est survenue',
}
