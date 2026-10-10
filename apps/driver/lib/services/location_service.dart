import 'dart:async';
import 'package:geolocator/geolocator.dart';
import '../api/api_client.dart';

class LocationUpdate {
  final double latitude;
  final double longitude;
  final double? speedKmh;
  final double? headingDeg;
  final double? accuracyM;

  LocationUpdate({
    required this.latitude,
    required this.longitude,
    this.speedKmh,
    this.headingDeg,
    this.accuracyM,
  });

  Map<String, dynamic> toJson() {
    return {
      'latitude': latitude,
      'longitude': longitude,
      'speedKmh': speedKmh,
      'headingDeg': headingDeg,
      'accuracyM': accuracyM,
      'source': 'MOBILE',
      'isSimulation': false,
    };
  }
}

class LocationService {
  final ApiClient _api = ApiClient();
  final Duration updateInterval = const Duration(seconds: 3);
  Timer? _timer;
  Position? _lastPosition;
  DateTime? _lastSent;
  bool _isTracking = false;

  bool get isTracking => _isTracking;
  Position? get lastPosition => _lastPosition;
  DateTime? get lastSent => _lastSent;

  Future<bool> checkPermission() async {
    LocationPermission permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    return permission == LocationPermission.always ||
        permission == LocationPermission.whileInUse;
  }

  Future<bool> isLocationEnabled() async {
    return await Geolocator.isLocationServiceEnabled();
  }

  Future<Position> getCurrentLocation() async {
    return await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.high,
      ),
    );
  }

void startTracking(
    String ambulanceId,
    Function(Position) onPosition,
    Function() onUpload, {
    Function(String)? onError,
  }) {
    _isTracking = true;
    _timer = Timer.periodic(updateInterval, (_) async {
      try {
        final pos = await getCurrentLocation();
        _lastPosition = pos;
        onPosition(pos);
        final sent = await _sendUpdate(ambulanceId, pos);
        if (sent) {
          _lastSent = DateTime.now();
          onUpload();
        } else {
          onError?.call('Location upload rejected (HTTP $_lastStatusCode).');
        }
      } catch (e) {
        // Retry on the next tick; never report a successful upload.
        onError?.call('GPS or upload failed: $e');
      }
    });
  }

  void stopTracking() {
    _isTracking = false;
    _timer?.cancel();
    _timer = null;
  }

  int? _lastStatusCode;

  Future<bool> _sendUpdate(String ambulanceId, Position pos) async {
    final update = LocationUpdate(
      latitude: pos.latitude,
      longitude: pos.longitude,
      speedKmh: pos.speed >= 0 ? pos.speed * 3.6 : null, // m/s to km/h
      headingDeg: pos.heading >= 0 ? pos.heading : null,
      accuracyM: pos.accuracy >= 0 ? pos.accuracy : null,
    );
    final response = await _api.post(
      '/api/ambulances/$ambulanceId/location',
      update.toJson(),
    );
    _lastStatusCode = response.statusCode;
    return response.statusCode >= 200 && response.statusCode < 300;
  }
}
