import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  matchesProduct,
  normalizeSearch,
  parseNumber,
  parseProductsCsv,
} from '../scripts/product-utils.js';

test('parseNumber entiende precios con símbolo y miles', () => {
  assert.equal(parseNumber('$2,499.99'), 2499.99);
  assert.equal(parseNumber('$189.99'), 189.99);
  assert.equal(parseNumber('4.7'), 4.7);
  assert.equal(parseNumber(''), null);
});

test('parseProductsCsv mapea el CSV público y descarta ids repetidos', () => {
  const csv = [
    'product_id,title,root_category,final_price,rating,images,product_description,brand',
    '"1","Laptop Gamer","Computers & Tablets","$2,499.99","4.5","[""https://img/1.jpg""]","Equipo para jugar","Acer"',
    '"1","Laptop Gamer","Computers & Tablets","$2,499.99","4.5","[""https://img/1.jpg""]","Equipo para jugar","Acer"',
    '"2","Lámpara de escritorio","Home","$39.99","4","https://img/2.jpg","Iluminación","Lum"',
  ].join('\n');

  const products = parseProductsCsv(csv, 10);
  assert.equal(products.length, 2);
  assert.equal(products[0].product_id, '1');
  assert.equal(products[0].title, 'Laptop Gamer');
  assert.equal(products[0].category, 'Computers & Tablets');
  assert.equal(products[0].price, 2499.99);
  assert.equal(products[0].rating, 4.5);
  assert.equal(products[0].image, 'https://img/1.jpg');
  assert.equal(products[0].brand, 'Acer');
  assert.equal(products[1].image, 'https://img/2.jpg');
});

test('la búsqueda de texto libre ignora acentos y exige todas las palabras', () => {
  const product = {
    title: 'Lámpara de escritorio',
    category: 'Home',
    brand: 'Lum',
    description: 'Iluminación LED para oficina',
  };
  assert.equal(normalizeSearch('LÁMPARA'), 'lampara');
  assert.equal(matchesProduct(product, 'lampara oficina'), true);
  assert.equal(matchesProduct(product, 'lampara gamer'), false);
  assert.equal(matchesProduct(product, ''), true);
});
