import { defineTheme } from '@presslabz/theme-kit'
import Code from './blocks/Code.astro'
import Divider from './blocks/Divider.astro'
import Heading from './blocks/Heading.astro'
import Image from './blocks/Image.astro'
import List from './blocks/List.astro'
import Paragraph from './blocks/Paragraph.astro'
import Quote from './blocks/Quote.astro'
import Archive from './templates/Archive.astro'
import Document from './templates/Document.astro'
import Home from './templates/Home.astro'
import NotFound from './templates/NotFound.astro'

/**
 * The theme PressLabz ships with, declared through the public contract with no
 * privileged path into the site — the same rule the built-in content types
 * follow, and the only way to know the contract is sufficient before somebody
 * outside this repository has to live with it.
 *
 * It covers every block type on purpose. The fallback in Blocks.astro exists
 * for themes that do not, and it is exercised by the tests rather than by the
 * theme everyone starts from.
 */
export default defineTheme({
  name: 'default',
  templates: { home: Home, archive: Archive, document: Document, notFound: NotFound },
  blocks: {
    paragraph: Paragraph,
    heading: Heading,
    quote: Quote,
    list: List,
    code: Code,
    image: Image,
    divider: Divider,
  },
})
