/** Locale registry for every UI string; missing keys fall through the harness locale chain
 *  (active → en → common → the key). `i18nZh.ts` is the key-set source of truth. */

/** Keyed `string`, not a `DictKey` union: call sites compose keys at runtime (`'form.' + form`), forcing a cast. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

export { DICT_ZH, type DictKey } from './i18nZh'
export { DICT_EN } from './i18nEn'
