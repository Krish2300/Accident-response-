import 'package:flutter/material.dart';
import '../services/driver_service.dart';
import '../services/location_service.dart';
import '../auth/auth_service.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  final _driverService = DriverService();
  final _locationService = LocationService();
  final _authService = AuthService();
  DriverAssignment? _assignment;
  String? _error;
  bool _loading = true;
  String _gpsStatus = 'NOT ACTIVE';
  double? _lat;
  double? _lng;
  double? _accuracy;
  double? _speed;
  double? _heading;
  DateTime? _lastUpload;
  String _networkStatus = 'UNKNOWN';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final assignment = await _driverService.getAssignment();
      setState(() {
        _assignment = assignment;
        _loading = false;
      });
    } catch (e) {
      setState(() {
        _error = e.toString();
        _loading = false;
      });
    }
  }

  Future<void> _startDuty() async {
    if (_assignment?.ambulance == null) return;
    final hasPermission = await _locationService.checkPermission();
    if (!hasPermission) {
      setState(() => _error = 'Location permission required');
      return;
    }
    final enabled = await _locationService.isLocationEnabled();
    if (!enabled) {
      setState(() => _error = 'GPS is disabled');
      return;
    }
    setState(() {
      _gpsStatus = 'ACTIVE';
      _error = null;
    });
    _locationService.startTracking(
      _assignment!.ambulance!.id,
      (pos) {
        setState(() {
          _lat = pos.latitude;
          _lng = pos.longitude;
          _accuracy = pos.accuracy;
          _speed = pos.speed >= 0 ? pos.speed * 3.6 : null;
          _heading = pos.heading >= 0 ? pos.heading : null;
        });
      },
      () {
        setState(() {
          _lastUpload = DateTime.now();
          _networkStatus = 'ONLINE';
        });
      },
      onError: (message) {
        setState(() {
          _networkStatus = 'ERROR';
          _error = message;
        });
      },
    );
  }

  void _stopDuty() {
    _locationService.stopTracking();
    setState(() {
      _gpsStatus = 'NOT ACTIVE';
      _networkStatus = 'STOPPED';
    });
  }

  @override
  Widget build(BuildContext context) {
    final ambulance = _assignment?.ambulance;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Driver Home'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await _authService.logout();
              if (!context.mounted) return;
              Navigator.pushReplacementNamed(context, '/login');
            },
          )
        ],
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (_error != null)
                    Text(_error!, style: const TextStyle(color: Colors.red)),
                  const SizedBox(height: 16),
                  Text('GPS Status: $_gpsStatus',
                      style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
                  const SizedBox(height: 8),
                  if (_lat != null && _lng != null) ...[
                    Text('Lat: ${_lat!.toStringAsFixed(6)}'),
                    Text('Lng: ${_lng!.toStringAsFixed(6)}'),
                    if (_accuracy != null)
                      Text('Accuracy: ${_accuracy!.toStringAsFixed(1)} m'),
                    if (_speed != null)
                      Text('Speed: ${_speed!.toStringAsFixed(1)} km/h'),
                    if (_heading != null)
                      Text('Heading: ${_heading!.toStringAsFixed(1)} deg'),
                  ] else
                    const Text('No GPS fix yet.'),
                  if (_lastUpload != null)
                    Text('Last upload: ${_lastUpload!.toIso8601String()}'),
                  Text('Network: $_networkStatus'),
                  const SizedBox(height: 24),
                  if (_assignment?.assigned == true && ambulance != null) ...[
                    Text('Ambulance: ${ambulance.vehicleNumber}'),
                    Text('Status: ${ambulance.status}'),
                    const SizedBox(height: 16),
                    ElevatedButton(
                      onPressed: _locationService.isTracking ? null : _startDuty,
                      child: const Text('START DUTY'),
                    ),
                    const SizedBox(height: 8),
                    ElevatedButton(
                      onPressed: _locationService.isTracking ? _stopDuty : null,
                      child: const Text('STOP DUTY'),
                    ),
                  ] else ...[
                    const Text('No ambulance currently assigned.'),
                  ],
                ],
              ),
            ),
    );
  }
}