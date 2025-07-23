import React, { useState } from 'react';
import './AgentDetails.css';
import PerformanceRubrics from '../PerformanceRubrics/PerformanceRubrics';

// Import icons
const imgWest = "http://localhost:3845/assets/dab477c6ade2d19b6d463e2d6994e32669d7440c.svg";
const imgWestIcon = "http://localhost:3845/assets/9fc49a8ad4582ec588abb9db25500f5811dbc74c.svg";
const imgPerson = "http://localhost:3845/assets/627d492e7c95cfbccc4574266f4dce2d0ee267c5.svg";
const imgCall = "http://localhost:3845/assets/ef6e5e33bf0c7a55016af261878a9906b26dd5b9.svg";
const imgCallIcon = "http://localhost:3845/assets/20f6037d1e0458230bce762850b2ffc99fe936cb.svg";
const imgLine = "http://localhost:3845/assets/3873aadcd49ad269806198541057edcaf8fbb825.svg";
const imgLine10 = "http://localhost:3845/assets/617d77add44dc3b59a619850aa9fc52a5d3b4974.svg";
const imgLine14 = "http://localhost:3845/assets/9082e57296c9ee82cca1c2ee794dfcdd9f9129df.svg";

function AgentDetails({ agent, onBack }) {
  const [showRubrics, setShowRubrics] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);
  const callHistory = agent.evaluations || [];

  const handleFileClick = (call) => {
    setSelectedFile(call);
    setShowRubrics(true);
  };

  const handleBackFromRubrics = () => {
    setShowRubrics(false);
    setSelectedFile(null);
  };

  if (showRubrics && selectedFile) {
    return (
      <PerformanceRubrics 
        fileName={selectedFile.fileName}
        s3Url={selectedFile.s3Url || 'mock-url'}
        onBack={handleBackFromRubrics}
      />
    );
  }

  return (
    <div className="agent-details-container">
      {/* Header with back button */}
      <div className="agent-details-header">
        <div className="back-button" onClick={onBack}>
          <div className="back-icon-container">
            <img src={imgWestIcon} alt="" className="west-icon" />
          </div>
          <span className="back-text">Agent Details</span>
        </div>
      </div>
      
      <div className="agent-details-columns">
        {/* Left Column */}
        <div className="left-column">

          {/* Agent Profile Card */}
          <div className="profile-card">
            <div className="profile-avatar">
              <img src={agent.avatar} alt="" className="avatar-background" />
              <div className="avatar-person-container">
                <img src={imgPerson} alt="" className="avatar-person" />
              </div>
            </div>
            <h2 className="profile-name">{agent.name}</h2>
            <p className="profile-contact-id">Contact ID: {agent.contactId}</p>
          </div>
        </div>

        {/* Right Column */}
        <div className="right-column">
          {/* Call History Card */}
          <div className="call-history-card">
            <div className="call-history-header">
              <div className="call-icon-container">
                <img src={imgCall} alt="Call" className="call-icon" />
                <img src={imgCallIcon} alt="" className="call-icon-inner" />
              </div>
              <h2 className="call-history-title">Call History</h2>
            </div>

            <div className="call-history-table">
              <div className="table-header">
                <div className="column file-name-column">File Name</div>
                <div className="column date-column">Date</div>
                <div className="column score-column">Score</div>
              </div>
              <div className="table-divider"></div>
              
              {callHistory.length > 0 ? callHistory.map((call, index) => (
                <div key={index} className="table-row-container">
                  <div className="table-row">
                    <div 
                      className="column file-name-column clickable-filename" 
                      onClick={() => handleFileClick(call)}
                    >
                      {call.fileName}
                    </div>
                    <div className="column date-column">{call.date}</div>
                    <div className="column score-column">{call.score}</div>
                  </div>
                  <div className="table-divider"></div>
                </div>
              )) : (
                <div className="table-row-container">
                  <div className="table-row">
                    <div className="column file-name-column">No call history available</div>
                    <div className="column date-column"></div>
                    <div className="column score-column"></div>
                  </div>
                  <div className="table-divider"></div>
                </div>
              )}
            </div>
          </div>

          {/* Total Cases Summary Card */}
          <div className="total-cases-card">
            <h2 className="total-cases-title">Total Cases</h2>
            <div className="total-cases-divider"></div>
            
            <div className="total-cases-content">
              <div className="cases-section">
                <p className="cases-count">{agent.totalCases}</p>
              </div>
              
              <div className="vertical-divider"></div>
              
              <div className="analysis-section">
                <h3 className="analysis-title">1st Half Year Analysis</h3>
                <p className="analysis-percentage">{agent.firstHalfAvg !== 'N/A' ? `${agent.firstHalfAvg}%` : 'N/A'}</p>
              </div>
              
              <div className="vertical-divider"></div>
              
              <div className="analysis-section">
                <h3 className="analysis-title">2nd Half Year Analysis</h3>
                <p className="analysis-percentage">{agent.secondHalfAvg !== 'N/A' ? `${agent.secondHalfAvg}%` : 'N/A'}</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default AgentDetails;