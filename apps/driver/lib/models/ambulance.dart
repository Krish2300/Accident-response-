class Ambulance {
  final String id;
  final String vehicleNumber;
  final String status;
  final double? latitude;
  final double? longitude;
  final String? lastLocationUpdate;

  Ambulance({
    required this.id,
    required this.vehicleNumber,
    required this.status,
    this.latitude,
    this.longitude,
    this.lastLocationUpdate,
  });

  factory Ambulance.fromJson(Map<String, dynamic> json) {
    return Ambulance(
      id: json['id'].toString(),
      vehicleNumber: json['vehicleNumber'].toString(),
      status: json['status'].toString(),
      latitude: json['latitude'] != null
          ? (json['latitude'] as num).toDouble()
          : null,
      longitude: json['longitude'] != null
          ? (json['longitude'] as num).toDouble()
          : null,
      lastLocationUpdate: json['lastLocationUpdate']?.toString(),
    );
  }
}

class DriverRoute {
  final String id;
  final String destinationName;
  final double? estimatedMinutes;
  final double distanceKm;
  final String provider;
  final bool isLiveTraffic;
  final bool isSimulation;
  final List<List<double>> polyline;

  DriverRoute({
    required this.id,
    required this.destinationName,
    required this.distanceKm,
    required this.provider,
    required this.isLiveTraffic,
    required this.isSimulation,
    required this.polyline,
    this.estimatedMinutes,
  });

  factory DriverRoute.fromJson(Map<String, dynamic> json) => DriverRoute(
    id: json['id'].toString(),
    destinationName: json['destinationName'].toString(),
    distanceKm: (json['distanceKm'] as num).toDouble(),
    estimatedMinutes: json['estimatedMinutes'] == null
        ? null
        : (json['estimatedMinutes'] as num).toDouble(),
    provider: json['provider'].toString(),
    isLiveTraffic: json['isLiveTraffic'] == true,
    isSimulation: json['isSimulation'] == true,
    polyline: (json['polyline'] as List<dynamic>? ?? [])
        .map(
          (point) => (point as List<dynamic>)
              .map((value) => (value as num).toDouble())
              .toList(),
        )
        .toList(),
  );
}
