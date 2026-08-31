import { effectiveProtocolVersion } from '../../nugetProtocol';

describe('effectiveProtocolVersion', () => {
  it('is 3 for *.json HTTP URLs and nuget.org', () => {
    expect(effectiveProtocolVersion('https://api.nuget.org/v3/index.json')).toBe('3');
    expect(effectiveProtocolVersion('http://nexus.example/index.json')).toBe('3');
  });

  it('is 2 for HTTP URLs that are not *.json', () => {
    expect(effectiveProtocolVersion('https://tfs.example/nuget')).toBe('2');
    expect(effectiveProtocolVersion('http://nexus.example/repository/nuget/')).toBe('2');
  });

  it('honours an explicit protocolVersion', () => {
    expect(effectiveProtocolVersion('https://api.nuget.org/v3/index.json', '2')).toBe('2');
    expect(effectiveProtocolVersion('https://tfs.example/nuget', '3')).toBe('3');
  });

  it('is undefined for local folders', () => {
    expect(effectiveProtocolVersion('D:\\packages')).toBeUndefined();
    expect(effectiveProtocolVersion('\\\\share\\pkgs')).toBeUndefined();
  });
});
