import assert from 'node:assert/strict';
import {normalizeTitle, suggestShelfMatches, planPhotoMatch} from '../shelf-photo-matcher.mjs';

const library=[
  {id:'work-1',title:'Babel',author:'R. F. Kuang',editions:[
    {id:'standard-1',isbn:'9780063021426',vendor:''},
    {id:'fairyloot-1',vendor:'FairyLoot',edition_name:'Exclusive Hardcover'}
  ]},
  {id:'work-2',title:'The Priory of the Orange Tree',author:'Samantha Shannon',editions:[]}
];
assert.equal(normalizeTitle('Babel - (z-library) (1).epub'),'babel');
assert.equal(normalizeTitle('[Z-Library] Babel.epub'),'babel');
assert.equal(normalizeTitle('The Priory of the Orange Tree (z-library).epub'),'the priory of the orange tree');

const babel=suggestShelfMatches({title:'Babel',author:'R. F. Kuang'},library);
assert.equal(babel[0].bookId,'work-1');
assert.equal(planPhotoMatch({},babel).action,'link_existing_book');
assert.equal(planPhotoMatch({},babel).editionId,null);

const fl=suggestShelfMatches({title:'Babel',author:'R. F. Kuang',editionVendor:'FairyLoot'},library);
assert.equal(planPhotoMatch({},fl).editionId,'fairyloot-1');

const uncertain=suggestShelfMatches({title:'Babel'},library);
assert.equal(planPhotoMatch({},uncertain).action,'review_candidates');
const unknown=suggestShelfMatches({title:'A Completely Different Book'},library);
assert.equal(planPhotoMatch({},unknown).action,'suggest_new_book');

// Equal-confidence duplicate canonical records are never auto-merged.
const duplicates=[library[0],{...library[0],id:'work-3'}];
const dup=suggestShelfMatches({title:'Babel',author:'R. F. Kuang'},duplicates);
assert.equal(planPhotoMatch({},dup).action,'review_candidates');
console.log('Shelf-photo matching and duplicate safety tests passed');
