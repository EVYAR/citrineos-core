import { describe, it, expect } from 'vitest';
import { connectionErrorCategory } from './connection-error-category.js';
describe('connection registration error diagnostics', () => {
  it('retains known category and nested PostgreSQL state only', () => {
    expect(connectionErrorCategory({name:'SequelizeDatabaseError',parent:{code:'22001',sql:'private sql',parameters:['private token']},message:'private password'})).toEqual({category:'SequelizeDatabaseError',sqlState:'22001'});
  });
  it('does not serialize arbitrary names, error messages, SQL, callback URLs or tokens', () => {
    const secret='private-signature-token-password';
    const result=connectionErrorCategory({name:secret,code:secret,message:secret,stack:secret,sql:secret,original:{code:secret},parent:{parameters:[secret]},callbackUrl:secret});
    expect(result).toEqual({category:'UnknownConnectionRegistrationError'});
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('rejects arbitrary five-letter strings as SQL states', () => expect(connectionErrorCategory({name:'Error',code:'TOKEN'})).toEqual({category:'Error'}));
  it('throwing error getters cannot escape the catch handler', () => {
    const row = Object.defineProperties({}, Object.fromEntries(['name','parent','original','code'].map(key => [key,{get(){throw Error('private getter secret');}}])));
    expect(() => connectionErrorCategory(row)).not.toThrow();
    expect(connectionErrorCategory(row)).toEqual({category:'UnknownConnectionRegistrationError'});
  });
  it('throwing Proxy and nested Proxy cannot escape the catch handler', () => {
    const proxy = new Proxy({}, {get(){throw Error('private proxy secret');}});
    expect(connectionErrorCategory(proxy)).toEqual({category:'UnknownConnectionRegistrationError'});
    expect(connectionErrorCategory({name:'Error',parent:proxy,original:{code:'22001'}})).toEqual({category:'Error',sqlState:'22001'});
  });
  it.each([null,undefined,'private exception',7])('safe for non-error value %s', value => expect(connectionErrorCategory(value)).toEqual({category:'UnknownConnectionRegistrationError'}));
});
