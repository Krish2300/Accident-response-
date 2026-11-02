import 'package:flutter/material.dart';
import '../services/driver_service.dart';
import '../services/location_service.dart';
import '../auth/auth_service.dart';
import '../models/ambulance.dart';

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
  String? _message;
  bool _loading = true;
  String _gpsStatus = 'NOT ACTIVE';
  double? _lat;
  double? _lng;
  double? _accuracy;
  double? _speed;
  double? _heading;
  DateTime? _lastUpload;
  String _networkStatus = 'UNKNOWN';
  List<DriverRoute> _routes = [];
  bool _decisionPending = false;
  bool _routesLoading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    DriverAssignment? assignment;
    List<DriverRoute> routes = [];
    String? assignmentError;
    String? routeError;
    try {
      assignment = await _driverService.getAssignment();
    } catch (error) {
      assignmentError = error.toString();
    }
    try {
      routes = await _driverService.getRoutes();
    } catch (error) {
      routeError = error.toString();
    }
    if (!mounted) return;
    setState(() {
      if (assignment != null) _assignment = assignment;
      if (routeError == null) _routes = routes;
      _error =
          [assignmentError, routeError].whereType<String>().join('\n').isEmpty
          ? null
          : [assignmentError, routeError].whereType<String>().join('\n');
      _loading = false;
    });
  }

  Future<void> _startDuty() async {
    if (_assignment?.ambulance == null ||
        !['ACCEPTED', 'DISPATCHED'].contains(_assignment?.status)) {
      return;
    }
    final hasPermission = await _locationService.checkPermission();
    if (!hasPermission) {
      if (!mounted) return;
      setState(() => _error = 'Location permission required');
      return;
    }
    final enabled = await _locationService.isLocationEnabled();
    if (!enabled) {
      if (!mounted) return;
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
        if (!mounted) return;
        setState(() {
          _lat = pos.latitude;
          _lng = pos.longitude;
          _accuracy = pos.accuracy;
          _speed = pos.speed >= 0 ? pos.speed * 3.6 : null;
          _heading = pos.heading >= 0 ? pos.heading : null;
        });
      },
      () {
        if (!mounted) return;
        setState(() {
          _lastUpload = DateTime.now();
          _networkStatus = 'ONLINE';
        });
      },
      onError: (message) {
        if (!mounted) return;
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

  Future<void> _respond(bool accept) async {
    final assignmentId = _assignment?.assignmentId;
    if (assignmentId == null || _decisionPending) return;
    setState(() {
      _decisionPending = true;
      _error = null;
      _message = null;
    });
    try {
      final status = await _driverService.respondToAssignment(
        assignmentId,
        accept: accept,
      );
      if (!mounted) return;
      if (accept) {
        await _load();
        if (!mounted) return;
        setState(
          () => _message =
              'Assignment accepted. Dispatch remains a separate dispatcher action.',
        );
      } else {
        setState(() {
          _assignment = null;
          _routes = [];
          _message = status == 'DECLINED'
              ? 'Assignment declined. The dispatcher has been notified; no automatic reassignment or dispatch occurred.'
              : 'Assignment decision recorded.';
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _decisionPending = false);
    }
  }

  Future<void> _refreshRoutes() async {
    if (_routesLoading) return;
    setState(() => _routesLoading = true);
    try {
      final routes = await _driverService.getRoutes();
      if (mounted) setState(() => _routes = routes);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _routesLoading = false);
    }
  }

  @override
  void dispose() {
    _locationService.stopTracking();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ambulance = _assignment?.ambulance;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Driver Home'),
        actions: [
          IconButton(
            tooltip: 'Refresh assignment and route',
            onPressed: _loading ? null : _load,
            icon: const Icon(Icons.refresh),
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            onPressed: () async {
              await _authService.logout();
              if (!context.mounted) return;
              Navigator.pushReplacementNamed(context, '/login');
            },
          ),
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
                  if (_message != null)
                    Text(
                      _message!,
                      style: const TextStyle(color: Colors.green),
                    ),
                  const SizedBox(height: 16),
                  Text(
                    'GPS Status: $_gpsStatus',
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 8),
                  if (_lat != null && _lng != null) ...[
                    const Text(
                      'Latest device GPS fix (server upload may be older):',
                    ),
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
                    Text(
                      'Last successful server upload: ${_lastUpload!.toIso8601String()} · ${DateTime.now().difference(_lastUpload!) > const Duration(minutes: 2) ? 'STALE' : 'current within 2 minutes'}',
                    ),
                  Text('Network: $_networkStatus'),
                  const SizedBox(height: 24),
                  if (_assignment?.assigned == true && ambulance != null) ...[
                    Text('Ambulance: ${ambulance.vehicleNumber}'),
                    Text('Status: ${ambulance.status}'),
                    Text('Assignment: ${_assignment!.status ?? 'unknown'}'),
                    if (_assignment!.status == 'ASSIGNED') ...[
                      const Text(
                        'Review this pending assignment. Accepting does not dispatch the ambulance.',
                      ),
                      Row(
                        children: [
                          ElevatedButton(
                            onPressed: _decisionPending
                                ? null
                                : () => _respond(true),
                            child: Text(
                              _decisionPending
                                  ? 'Saving…'
                                  : 'ACCEPT ASSIGNMENT',
                            ),
                          ),
                          const SizedBox(width: 8),
                          OutlinedButton(
                            onPressed: _decisionPending
                                ? null
                                : () => _respond(false),
                            child: const Text('DECLINE'),
                          ),
                        ],
                      ),
                    ],
                    const SizedBox(height: 16),
                    ElevatedButton(
                      onPressed:
                          _locationService.isTracking ||
                              ![
                                'ACCEPTED',
                                'DISPATCHED',
                              ].contains(_assignment!.status)
                          ? null
                          : _startDuty,
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
                  const SizedBox(height: 24),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      const Text(
                        'Dispatched response route',
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          fontSize: 18,
                        ),
                      ),
                      TextButton(
                        onPressed: _routesLoading ? null : _refreshRoutes,
                        child: Text(_routesLoading ? 'Refreshing…' : 'Refresh'),
                      ),
                    ],
                  ),
                  if (_routes.isEmpty)
                    const Text(
                      'No dispatched response route is available yet.',
                    ),
                  for (final route in _routes)
                    Card(
                      child: ExpansionTile(
                        title: Text('Destination: ${route.destinationName}'),
                        subtitle: Text(
                          '${route.distanceKm} km · ${route.estimatedMinutes == null ? 'ETA unavailable' : '${route.estimatedMinutes} minute estimate'} · provider ${route.provider}${route.isSimulation ? ' · simulation route' : ''}\nisLiveTraffic: ${route.isLiveTraffic}${route.isLiveTraffic ? '' : ' (non-live/simulated traffic)'} · ${route.polyline.length} geometry points',
                        ),
                        children: [
                          Padding(
                            padding: const EdgeInsets.all(12),
                            child: SelectableText(
                              route.polyline.isEmpty
                                  ? 'Route geometry unavailable.'
                                  : route.polyline
                                        .map(
                                          (point) => '${point[0]}, ${point[1]}',
                                        )
                                        .join(' → '),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
    );
  }
}
