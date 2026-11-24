/**
 * Boot. The pair page is the same bundle in "pair mode": if this document is
 * `.../pair/`, read the fragment FIRST and erase it before anything else runs.
 */
import { render } from 'preact';
import { consumePairFragment } from '../core/pairing.js';
import { App } from './App.js';
import './styles.css';

const isPairPage = /\/pair\/?(index\.html)?$/.test(location.pathname);
const pairTarget = isPairPage ? consumePairFragment(window) : undefined;
render(<App pairPage={isPairPage} pairTarget={pairTarget} />, document.getElementById('app') as HTMLElement);
