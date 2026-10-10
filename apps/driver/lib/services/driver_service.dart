import 'dart:convert';
import '../api/api_client.dart';
import '../models/ambulance.dart';

class DriverAssignment {
  final bool assigned;
  final Ambulance? ambulance;

  DriverAssignment({required this.assigned, this.ambulance});

  factory DriverAssignment.fromJson(Map<String, dynamic> json) {
    return DriverAssignment(
      assigned: json['assigned'] as bool,
      ambulance: json['ambulance'] != null ? Ambulance.fromJson(json['ambulance'] as Map<String, dynamic>) : null,
    );
  }
}

class DriverService {
  final ApiClient _api = ApiClient();

  Future<DriverAssignment> getAssignment() async {
    final response = await _api.get('/api/drivers/me/assignment');
    if (response.statusCode == 200) {
      final data = jsonDecode(response.body) as Map<String, dynamic>;
      return DriverAssignment.fromJson(data);
    }
    throw Exception('Failed to get assignment: ');
  }
}
