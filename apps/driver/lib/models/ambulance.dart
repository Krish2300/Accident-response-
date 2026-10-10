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
      latitude: json['latitude'] != null ? (json['latitude'] as num).toDouble() : null,
      longitude: json['longitude'] != null ? (json['longitude'] as num).toDouble() : null,
      lastLocationUpdate: json['lastLocationUpdate']?.toString(),
    );
  }
}
