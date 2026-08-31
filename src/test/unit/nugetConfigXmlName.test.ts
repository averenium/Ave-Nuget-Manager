import { decodeXmlLocalName, encodeXmlLocalName } from '../../nugetConfigXmlName';

describe('encodeXmlLocalName / decodeXmlLocalName', () => {
  it('encodes a space as _x0020_ and round-trips', () => {
    expect(encodeXmlLocalName('My Feed')).toBe('My_x0020_Feed');
    expect(decodeXmlLocalName('My_x0020_Feed')).toBe('My Feed');
    expect(decodeXmlLocalName(encodeXmlLocalName('My Feed'))).toBe('My Feed');
  });

  it('leaves nuget.org unchanged', () => {
    expect(encodeXmlLocalName('nuget.org')).toBe('nuget.org');
    expect(decodeXmlLocalName('nuget.org')).toBe('nuget.org');
  });

  it('escapes an underscore that would look like an encode sequence', () => {
    expect(encodeXmlLocalName('_x0020_Foo')).toBe('_x005F_x0020_Foo');
    expect(decodeXmlLocalName(encodeXmlLocalName('_x0020_Foo'))).toBe('_x0020_Foo');
  });
});
