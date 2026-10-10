/// Runtime endpoints for the driver app.
///
/// The default suits the Android emulator, where the host machine is reachable at
/// 10.0.2.2 on the same port the server binds. A physical phone needs the host's LAN
/// address instead, so the value is supplied at build time rather than edited per
/// machine:
///
///   flutter build apk --debug --dart-define=API_BASE_URL=http://192.168.1.8:4000
class AppConfig {
  static const String baseUrl = String.fromEnvironment(
    'API_BASE_URL',
    defaultValue: 'http://10.0.2.2:4000',
  );
}